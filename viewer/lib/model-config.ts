export const GEMINI_MODEL_OPTIONS = [
  { value: "", label: "Pipeline default" },
  { value: "gemini-3.7-flash", label: "3.7 Flash" },
  { value: "gemini-2.5-flash", label: "2.5 Flash" },
  { value: "gemini-2.5-pro-preview-06-05", label: "2.5 Pro" },
] as const;

export function modelOverride(model: unknown): { model?: string } {
  return typeof model === "string" && model.length > 0 ? { model } : {};
}
