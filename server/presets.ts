// Pure helpers for turning a preset into a Claude session opening message.
// No db / fs / network here — kept trivially testable. The DB CRUD for presets
// lives inline in the routes (server/index.ts), like repos/hosts/tasks.

/** Fill {title}/{slug}/{branch}/{prompt} (and any other {key}); unknown → "". */
export function renderDispatchPrompt(template: string, vars: Record<string, string>): string {
  return (template || "").replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

/** The "本任务已带入 skills: …" line appended to the opening message so the
 *  user and Claude both see what was delivered. Empty when nothing was. */
export function skillsLine(names: string[]): string {
  return names.length ? `\n\n本任务已带入 skills: ${names.join(", ")}` : "";
}
