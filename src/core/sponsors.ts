// Sponsors for race-day banners and flags. Known Australian motorsport
// brands get their colours, as wordmarks only (no logos); any other name
// gets a colour of its own. Users can edit or clear the list.

/** Background and lettering for brands seen around Australian motorsport (wordmarks only). */
const BRAND_COLOURS: Record<string, [string, string]> = {
  "supercheap auto": ["#e2231a", "#ffffff"],
  repco: ["#0b3b8c", "#ffffff"],
  "bob jane t-marts": ["#ffd200", "#141414"],
  penrite: ["#141414", "#f5c400"],
  nulon: ["#0057a8", "#ffffff"],
  ampol: ["#ffffff", "#e4002b"],
  autobarn: ["#d71920", "#ffffff"],
  coates: ["#ffcd00", "#141414"],
  castrol: ["#00843d", "#ffffff"],
  "shell v-power": ["#ffd500", "#dd1d21"],
  racq: ["#003b71", "#ffffff"],
  nrma: ["#003b71", "#ffffff"],
  mobil: ["#ffffff", "#0b4ea2"],
  valvoline: ["#00205b", "#ffffff"],
  "pirtek": ["#141414", "#ffd100"],
  "gulf western oil": ["#0d2c6c", "#f28c00"],
};

export const DEFAULT_SPONSORS = "Supercheap Auto, Repco, Bob Jane T-Marts, Penrite, Nulon, Ampol, Autobarn, Coates, Castrol, Shell V-Power";

export interface Sponsor {
  name: string;
  bg: string;
  ink: string;
}

/** The sponsor list from a comma-separated string; unknown names get a colour of their own. */
export function sponsors(list: string): Sponsor[] {
  return list.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 24).map((name) => {
    const known = BRAND_COLOURS[name.toLowerCase()];
    if (known) return { name, bg: known[0], ink: known[1] };
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return { name, bg: `hsl(${h % 360}, 70%, 38%)`, ink: "#ffffff" };
  });
}
