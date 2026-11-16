import inputs from "../../spekkr.inputs.json";
const hex = /^#[0-9a-fA-F]{6}$/;
const i = inputs as Record<string, unknown>;
export const ACCESS_MODES = ["only_me", "invite_only", "open"] as const;
export type AccessMode = typeof ACCESS_MODES[number];
export const ACCESS_LABELS: Record<AccessMode, string> = {
  only_me: "Only me — sign-up closes after the first account",
  invite_only: "Invite only — the owner invites people by email",
  open: "Open — anyone can create an account",
};
export const settings = {
  appName: (typeof i.app_name === "string" && i.app_name.trim()) || "Notes",
  accentColor: typeof i.accent_color === "string" && hex.test(i.accent_color) ? i.accent_color : "#7c5cff",
  seedDemo: i.seed_demo === undefined ? true : Boolean(i.seed_demo),
  /** Who can create accounts: the first account becomes the owner in every mode. */
  access: (ACCESS_MODES as readonly unknown[]).includes(i.access) ? (i.access as AccessMode) : "only_me",
  /** Documentation switch only: the README and wrangler.jsonc assume Cloudflare Access in front of the site. */
  cloudflareAccess: i.cloudflare_access === true,
};
