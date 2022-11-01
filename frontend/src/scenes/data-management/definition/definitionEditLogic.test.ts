import { definitionLogic } from 'scenes/data-management/definition/definitionLogic'
import { useMocks } from '~/mocks/jest'
import { mockEventDefinitions, mockEventPropertyDefinition } from '~/test/mocks'
import { initKeaTests } from '~/test/init'
import { definitionEditLogic } from 'scenes/data-management/definition/definitionEditLogic'
import { expectLogic } from 'kea-test-utils'
import { eventDefinitionsTableLogic } from 'scenes/data-management/events/eventDefinitionsTableLogic'
import { eventPropertyDefinitionsTableLogic } from 'scenes/data-management/event-properties/eventPropertyDefinitionsTableLogic'
import { router } from 'kea-router'
import { urls } from 'scenes/urls'

describe('definitionEditLogic', () => {
    let logic: ReturnType<typeof definitionEditLogic.build>

    beforeEach(async () => {
        useMocks({
            get: {
                '/api/projects/:team/event_definitions/:id': (req) => {
                    if (req.params['id'] === 'tags') {
                        return [200, ['the', 'event', 'tags', 'array']]
                    }
                    return [200, mockEventDefinitions[0]]
                },
                '/api/projects/:team/property_definitions/:id': (req) => {
                    if (req.params['id'] === 'tags') {
                        return [200, ['the', 'property', 'tags', 'array']]
                    }
                    return [200, mockEventPropertyDefinition]
                },
                '/api/projects/@current/event_definitions/': {
                    results: mockEventDefinitions,
                    count: mockEventDefinitions.length,
                },
                '/api/projects/@current/property_definitions/': {
                    results: [mockEventPropertyDefinition],
                    count: 1,
                },
            },
            patch: {
                '/api/projects/:team/event_definitions/:id': mockEventDefinitions[0],
                '/api/projects/:team/property_definitions/:id': mockEventPropertyDefinition,
            },
        })
        initKeaTests()
    })

    describe('for event definitions', () => {
        beforeEach(async () => {
            router.actions.push(urls.eventDefinition('1'))
            await expectLogic(definitionLogic({ id: '1' })).toFinishAllListeners()
            eventDefinitionsTableLogic.mount()
            eventPropertyDefinitionsTableLogic.mount()
            logic = definitionEditLogic({ id: '1', definition: mockEventDefinitions[0] })
            logic.mount()
        })

        it('save definition', async () => {
            await expectLogic(logic, () => {
                logic.actions.saveDefinition(mockEventDefinitions[0])
            }).toDispatchActionsInAnyOrder([
                'saveDefinition',
                'setPageMode',
                'setDefinition',
                eventDefinitionsTableLogic.actionCreators.setLocalEventDefinition(mockEventDefinitions[0]),
            ])
        })

        it('can load tags', async () => {
            await expectLogic(logic, () => {
                logic.actions.loadTags()
            })
                .toFinishAllListeners()
                .toMatchValues({
                    tags: ['the', 'event', 'tags', 'array'],
                })
        })
    })

    describe('for property definitions', () => {
        beforeEach(async () => {
            router.actions.push(urls.eventPropertyDefinition('1'))
            await expectLogic(definitionLogic({ id: '1' })).toFinishAllListeners()
            eventDefinitionsTableLogic.mount()
            eventPropertyDefinitionsTableLogic.mount()
            logic = definitionEditLogic({ id: '1', definition: mockEventDefinitions[0] })
            logic.mount()
        })

        it('save definition', async () => {
            await expectLogic(logic, () => {
                logic.actions.saveDefinition(mockEventPropertyDefinition)
            }).toDispatchActionsInAnyOrder([
                'saveDefinition',
                'setPageMode',
                'setDefinition',
                eventPropertyDefinitionsTableLogic.actionCreators.setLocalEventPropertyDefinition(
                    mockEventPropertyDefinition
                ),
            ])
        })

        it('can load tags', async () => {
            await expectLogic(logic, () => {
                logic.actions.loadTags()
            })
                .toFinishAllListeners()
                .toMatchValues({
                    tags: ['the', 'property', 'tags', 'array'],
                })
        })
    })
})
