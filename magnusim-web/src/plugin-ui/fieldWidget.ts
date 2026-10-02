/**
 * The props a plugin field widget gets (pluginUi.registerFieldWidget). The
 * schema form passes these and more; a widget renders only its control, the
 * form draws the row and the label.
 */
export type FieldWidgetProps = { id: string; value: unknown; label: string; schema: Record<string, unknown>; options?: Record<string, unknown>; required?: boolean; disabled?: boolean; readonly?: boolean; onChange: (v: unknown) => void; onBlur?: (id: string, v: unknown) => void; onFocus?: (id: string, v: unknown) => void };
