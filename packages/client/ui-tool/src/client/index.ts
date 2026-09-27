/** Browser Tool plugin: whole-call composition and keyed atomic Tool views. */
export { apply, inject } from './apply.ts'
export type {
  StartedToolCallViewProps, ToolCallCommonProps, ToolCallOwnerProps, ToolCallPhaseProps, ToolCallViewProps,
  ToolCallHookContext, ToolCallInjected, ToolHostInfoInjected, ToolTreeProps, UseToolCallArgumentsPartial,
} from './contract/slots.ts'
/** Flatten one settled result node to display text under the generic Tool-row contract. */
export { resultText } from './tool/models/tool-call-model.ts'
