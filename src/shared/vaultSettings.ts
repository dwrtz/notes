// Per-vault settings, stored as JSON on the vault and synced to every device.
export interface VaultSettings {
  newNoteLocation: "root" | "current" | "folder"; newNoteFolder: string;
  attachmentLocation: "root" | "current" | "folder" | "subfolder"; attachmentFolder: string;
  linkFormat: "shortest" | "relative" | "absolute"; useWikilinks: boolean; autoUpdateLinks: boolean;
  defaultMode: "live" | "source" | "reading"; propertiesInDocument: "visible" | "hidden" | "source";
  readableLineLength: boolean; deleteBehavior: "trash" | "permanent";
  dailyFolder: string; dailyFormat: string; dailyTemplate: string; openDailyOnStart: boolean;
  templatesFolder: string; templateDateFormat: string; templateTimeFormat: string;
  hotkeys: Record<string, string>; // command id -> key combo, overrides defaults ("" = none)
  pinnedCommands: string[];
}
export const DEFAULT_SETTINGS: VaultSettings = {
  newNoteLocation: "root", newNoteFolder: "", attachmentLocation: "folder", attachmentFolder: "Attachments",
  linkFormat: "shortest", useWikilinks: true, autoUpdateLinks: true,
  defaultMode: "live", propertiesInDocument: "visible", readableLineLength: true, deleteBehavior: "trash",
  dailyFolder: "", dailyFormat: "YYYY-MM-DD", dailyTemplate: "", openDailyOnStart: false,
  templatesFolder: "Templates", templateDateFormat: "YYYY-MM-DD", templateTimeFormat: "HH:mm",
  hotkeys: {}, pinnedCommands: [],
};
export function cleanSettings(input: unknown): VaultSettings {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: any = { ...DEFAULT_SETTINGS };
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof def === "boolean" && typeof v === "boolean") out[k] = v;
    else if (typeof def === "string" && typeof v === "string" && v.length <= 200) out[k] = v;
    else if (k === "hotkeys" && v && typeof v === "object" && !Array.isArray(v)) out[k] = Object.fromEntries(Object.entries(v).filter(([a, b]) => typeof b === "string" && a.length < 80 && (b as string).length < 40));
    else if (k === "pinnedCommands" && Array.isArray(v)) out[k] = v.filter(x => typeof x === "string").slice(0, 20);
  }
  const enums: Record<string, string[]> = { newNoteLocation: ["root", "current", "folder"], attachmentLocation: ["root", "current", "folder", "subfolder"], linkFormat: ["shortest", "relative", "absolute"], defaultMode: ["live", "source", "reading"], propertiesInDocument: ["visible", "hidden", "source"], deleteBehavior: ["trash", "permanent"] };
  for (const [k, vals] of Object.entries(enums)) if (!vals.includes(out[k])) out[k] = (DEFAULT_SETTINGS as any)[k];
  if (!out.dailyFormat.trim()) out.dailyFormat = "YYYY-MM-DD";
  return out;
}
