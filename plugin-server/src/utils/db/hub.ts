import ClickHouse from '@posthog/clickhouse'
import * as Sentry from '@sentry/node'
import * as fs from 'fs'
import { createPool } from 'generic-pool'
import { StatsD } from 'hot-shots'
import Redis from 'ioredis'
import { Kafka, logLevel, SASLOptions } from 'kafkajs'
import { DateTime } from 'luxon'
import * as path from 'path'
import { types as pgTypes } from 'pg'
import { ConnectionOptions } from 'tls'

import { defaultConfig } from '../../config/config'
import { JobQueueManager } from '../../main/job-queues/job-queue-manager'
import { connectObjectStorage, ObjectStorage } from '../../main/services/object_storage'
import { Hub, KafkaSecurityProtocol, PluginId, PluginServerCapabilities, PluginsServerConfig } from '../../types'
import { ActionManager } from '../../worker/ingestion/action-manager'
import { ActionMatcher } from '../../worker/ingestion/action-matcher'
import { HookCommander } from '../../worker/ingestion/hooks'
import { OrganizationManager } from '../../worker/ingestion/organization-manager'
import { EventsProcessor } from '../../worker/ingestion/process-event'
import { TeamManager } from '../../worker/ingestion/team-manager'
import { InternalMetrics } from '../internal-metrics'
import { killProcess } from '../kill'
import { status } from '../status'
import { createPostgresPool, createRedis, logOrThrowJobQueueError, UUIDT } from '../utils'
import { PluginsApiKeyManager } from './../../worker/vm/extensions/helpers/api-key-manager'
import { RootAccessManager } from './../../worker/vm/extensions/helpers/root-acess-manager'
import { PromiseManager } from './../../worker/vm/promise-manager'
import { DB } from './db'
import { KafkaProducerWrapper } from './kafka-producer-wrapper'

const { version } = require('../../../package.json')

export async function createHub(
    config: Partial<PluginsServerConfig> = {},
    threadId: number | null = null,
    capabilities: PluginServerCapabilities | null = null
): Promise<[Hub, () => Promise<void>]> {
    status.info('ℹ️', `Connecting to all services:`)

    const serverConfig: PluginsServerConfig = {
        ...defaultConfig,
        ...config,
    }
    if (capabilities === null) {
        capabilities = { ingestion: true, pluginScheduledTasks: true, processJobs: true, processAsyncHandlers: false }
    }
    const instanceId = new UUIDT()

    let statsd: StatsD | undefined
    let eventLoopLagInterval: NodeJS.Timeout | undefined
    let eventLoopLagSetTimeoutInterval: NodeJS.Timeout | undefined

    const conversionBufferEnabledTeams = new Set(
        serverConfig.CONVERSION_BUFFER_ENABLED_TEAMS.split(',').filter(String).map(Number)
    )

    if (serverConfig.STATSD_HOST) {
        status.info('🤔', `StatsD`)
        statsd = new StatsD({
            port: serverConfig.STATSD_PORT,
            host: serverConfig.STATSD_HOST,
            prefix: serverConfig.STATSD_PREFIX,
            telegraf: true,
            errorHandler: (error) => {
                status.warn('⚠️', 'StatsD error', error)
                Sentry.captureException(error, {
                    extra: { threadId },
                })
            },
        })
        eventLoopLagInterval = setInterval(() => {
            const time = new Date()
            setImmediate(() => {
                statsd?.timing('event_loop_lag', time, {
                    instanceId: instanceId.toString(),
                    threadId: String(threadId),
                })
            })
        }, 2000)
        eventLoopLagSetTimeoutInterval = setInterval(() => {
            const time = new Date()
            setTimeout(() => {
                statsd?.timing('event_loop_lag_set_timeout', time, {
                    instanceId: instanceId.toString(),
                    threadId: String(threadId),
                })
            }, 0)
        }, 2000)
        // don't repeat the same info in each thread
        if (threadId === null) {
            status.info(
                '🪵',
                `Sending metrics to StatsD at ${serverConfig.STATSD_HOST}:${serverConfig.STATSD_PORT}, prefix: "${serverConfig.STATSD_PREFIX}"`
            )
        }
        status.info('👍', `StatsD`)
    }

    let kafkaSsl: ConnectionOptions | boolean | undefined
    if (
        serverConfig.KAFKA_CLIENT_CERT_B64 &&
        serverConfig.KAFKA_CLIENT_CERT_KEY_B64 &&
        serverConfig.KAFKA_TRUSTED_CERT_B64
    ) {
        kafkaSsl = {
            cert: Buffer.from(serverConfig.KAFKA_CLIENT_CERT_B64, 'base64'),
            key: Buffer.from(serverConfig.KAFKA_CLIENT_CERT_KEY_B64, 'base64'),
            ca: Buffer.from(serverConfig.KAFKA_TRUSTED_CERT_B64, 'base64'),

            /* Intentionally disabling hostname checking. The Kafka cluster runs in the cloud and Apache
            Kafka on Heroku doesn't currently provide stable hostnames. We're pinned to a specific certificate
            #for this connection even though the certificate doesn't include host information. We rely
            on the ca trust_cert for this purpose. */
            rejectUnauthorized: false,
        }
    } else if (
        serverConfig.KAFKA_SECURITY_PROTOCOL === KafkaSecurityProtocol.Ssl ||
        serverConfig.KAFKA_SECURITY_PROTOCOL === KafkaSecurityProtocol.SaslSsl
    ) {
        kafkaSsl = true
    }

    let kafkaSasl: SASLOptions | undefined
    if (serverConfig.KAFKA_SASL_MECHANISM && serverConfig.KAFKA_SASL_USER && serverConfig.KAFKA_SASL_PASSWORD) {
        kafkaSasl = {
            mechanism: serverConfig.KAFKA_SASL_MECHANISM,
            username: serverConfig.KAFKA_SASL_USER,
            password: serverConfig.KAFKA_SASL_PASSWORD,
        }
    }

    let clickhouse: ClickHouse | undefined
    let kafka: Kafka | undefined
    let kafkaProducer: KafkaProducerWrapper | undefined

    if (serverConfig.KAFKA_ENABLED) {
        status.info('🤔', `ClickHouse`)
        clickhouse = new ClickHouse({
            host: serverConfig.CLICKHOUSE_HOST,
            port: serverConfig.CLICKHOUSE_SECURE ? 8443 : 8123,
            protocol: serverConfig.CLICKHOUSE_SECURE ? 'https:' : 'http:',
            user: serverConfig.CLICKHOUSE_USER,
            password: serverConfig.CLICKHOUSE_PASSWORD || undefined,
            dataObjects: true,
            queryOptions: {
                database: serverConfig.CLICKHOUSE_DATABASE,
                output_format_json_quote_64bit_integers: false,
            },
            ca: serverConfig.CLICKHOUSE_CA
                ? fs.readFileSync(path.join(serverConfig.BASE_DIR, serverConfig.CLICKHOUSE_CA)).toString()
                : undefined,
            rejectUnauthorized: serverConfig.CLICKHOUSE_CA ? false : undefined,
        })
        await clickhouse.querying('SELECT 1') // test that the connection works
        status.info('👍', `ClickHouse`)

        status.info('🤔', `Kafka`)
        kafka = new Kafka({
            clientId: `plugin-server-v${version}-${instanceId}`,
            brokers: serverConfig.KAFKA_HOSTS.split(','),
            logLevel: logLevel.WARN,
            ssl: kafkaSsl,
            sasl: kafkaSasl,
            connectionTimeout: 3000, // default: 1000
            authenticationTimeout: 3000, // default: 1000
        })
        const producer = kafka.producer({ retry: { retries: 10, initialRetryTime: 1000, maxRetryTime: 30 } })
        await producer?.connect()

        kafkaProducer = new KafkaProducerWrapper(producer, statsd, serverConfig)
        status.info('👍', `Kafka`)
    }

    // `node-postgres` will return dates as plain JS Date objects, which will use the local timezone.
    // This converts all date fields to a proper luxon UTC DateTime and then casts them to a string
    // Unfortunately this must be done on a global object before initializing the `Pool`
    pgTypes.setTypeParser(1083 /* types.TypeId.TIME */, (timeStr) =>
        timeStr ? DateTime.fromSQL(timeStr, { zone: 'utc' }).toISO() : null
    )
    pgTypes.setTypeParser(1114 /* types.TypeId.TIMESTAMP */, (timeStr) =>
        timeStr ? DateTime.fromSQL(timeStr, { zone: 'utc' }).toISO() : null
    )
    pgTypes.setTypeParser(1184 /* types.TypeId.TIMESTAMPTZ */, (timeStr) =>
        timeStr ? DateTime.fromSQL(timeStr, { zone: 'utc' }).toISO() : null
    )

    status.info('🤔', `Postgresql`)
    const postgres = createPostgresPool(serverConfig)
    status.info('👍', `Postgresql`)

    status.info('🤔', `Redis`)
    const redisPool = createPool<Redis.Redis>(
        {
            create: () => createRedis(serverConfig),
            destroy: async (client) => {
                await client.quit()
            },
        },
        {
            min: serverConfig.REDIS_POOL_MIN_SIZE,
            max: serverConfig.REDIS_POOL_MAX_SIZE,
            autostart: true,
        }
    )
    status.info('👍', `Redis`)

    status.info('🤔', `Storage`)
    const objectStorage: ObjectStorage = connectObjectStorage(serverConfig)
    try {
        if (serverConfig.OBJECT_STORAGE_ENABLED && (await objectStorage.healthCheck())) {
            status.info('👍', `storage 🪣`)
        } else {
            status.info('🪣', `storage not in use`)
        }
    } catch (e) {
        status.warn('🪣', `storage failed healthcheck: ${e}`)
    }

    const db = new DB(
        postgres,
        redisPool,
        kafkaProducer,
        clickhouse,
        statsd,
        serverConfig.PERSON_INFO_CACHE_TTL,
        new Set(serverConfig.PERSON_INFO_TO_REDIS_TEAMS.split(',').filter(String).map(Number))
    )
    const teamManager = new TeamManager(db, serverConfig, statsd)
    const organizationManager = new OrganizationManager(db)
    const pluginsApiKeyManager = new PluginsApiKeyManager(db)
    const rootAccessManager = new RootAccessManager(db)
    const promiseManager = new PromiseManager(serverConfig, statsd)
    const actionManager = new ActionManager(db)
    await actionManager.prepare()

    const hub: Omit<Hub, 'eventsProcessor'> = {
        ...serverConfig,
        instanceId,
        capabilities,
        db,
        postgres,
        redisPool,
        clickhouse,
        kafka,
        kafkaProducer,
        statsd,

        plugins: new Map(),
        pluginConfigs: new Map(),
        pluginConfigsPerTeam: new Map(),
        pluginConfigSecrets: new Map(),
        pluginConfigSecretLookup: new Map(),

        pluginSchedule: null,
        pluginSchedulePromises: { runEveryMinute: {}, runEveryHour: {}, runEveryDay: {} },

        teamManager,
        organizationManager,
        pluginsApiKeyManager,
        rootAccessManager,
        promiseManager,
        actionManager,
        actionMatcher: new ActionMatcher(db, actionManager, statsd),
        hookCannon: new HookCommander(db, teamManager, organizationManager, statsd),
        conversionBufferEnabledTeams,
    }

    // :TODO: This is only used on worker threads, not main
    hub.eventsProcessor = new EventsProcessor(hub as Hub)
    hub.jobQueueManager = new JobQueueManager(hub as Hub)

    if (serverConfig.CAPTURE_INTERNAL_METRICS) {
        hub.internalMetrics = new InternalMetrics(hub as Hub)
    }

    try {
        await hub.jobQueueManager.connectProducer()
    } catch (error) {
        try {
            logOrThrowJobQueueError(hub as Hub, error, `Can not start job queue producer!`)
        } catch {
            killProcess()
        }
    }

    const closeHub = async () => {
        if (eventLoopLagInterval) {
            clearInterval(eventLoopLagInterval)
        }

        if (eventLoopLagSetTimeoutInterval) {
            clearInterval(eventLoopLagSetTimeoutInterval)
        }

        hub.mmdbUpdateJob?.cancel()
        await hub.db.postgresLogsWrapper.flushLogs()
        await hub.jobQueueManager?.disconnectProducer()
        if (kafkaProducer) {
            clearInterval(kafkaProducer.flushInterval)
            await kafkaProducer.flush()
            await kafkaProducer.producer.disconnect()
        }
        await redisPool.drain()
        await redisPool.clear()
        await hub.postgres.end()
    }

    return [hub as Hub, closeHub]
}
