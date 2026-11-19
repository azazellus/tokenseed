// Developer exports: the Appearance tokens and the ColorScheme tokens for Android, each as JSON or as Kotlin
// for Jetpack Compose. Every token is resolved to a HEX value, for every theme and every appearance.
// Pure functions, no Figma API, so they can be tested with test/logic.test.ts.
// The input has the same shape as the color tables use: a plan, or the variables read from the file.

import type { TableSource } from "./tables.ts";
import { isValidHex, relativeLuminance } from "./color.ts";

// How token names are written in the export. Example for color/bg/brand/bold:
// dot -> color.bg.brand.bold, pascal -> ColorBgBrandBold, camel -> colorBgBrandBold, kebab -> --color-bg-brand-bold
export type NamingStyle = "dot" | "pascal" | "camel" | "kebab";
export type ExportOptions = { keepColorPrefix: boolean; naming: NamingStyle };

export type AppearanceExport = {
  version: 1;
  themes: Record<string, { appearances: Record<string, Record<string, string>> }>;
};

const EXPORT_VERSION = 1;

// The export name of one Appearance token, such as "color/bg/brand/bold".
export function exportName(name: string, options: ExportOptions): string {
  let parts = name.split("/");
  if (!options.keepColorPrefix && parts[0] === "color") parts = parts.slice(1);
  // Words inside a part ("on-dark") count as separate words for the cases that join words.
  const words = parts.flatMap((p) => p.split("-")).filter(Boolean);
  const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);
  switch (options.naming) {
    case "dot": return parts.join(".");
    case "pascal": return words.map(cap).join("");
    case "camel": return words.map((w, i) => (i === 0 ? w : cap(w))).join("");
    case "kebab": return "--" + words.join("-");
  }
}

// Resolves a Theme token in one theme to HEX, following its link to a Primitive. An alpha token adds its
// opacity as two more digits. Returns null when the token cannot be resolved to a color.
function themeResolver(source: TableSource): (name: string, themeMode: string) => string | null {
  const byName = (c: string) => new Map(source.variables.filter((v) => v.collection === c).map((v) => [v.name, v]));
  const prim = byName("Primitives");
  const theme = byName("Theme");

  // A Primitive's HEX value (its only mode), or null when it is not a color.
  const primHex = (name: string): string | null => {
    const v = prim.get(name);
    const value = v ? Object.values(v.values)[0] : undefined;
    return typeof value === "string" && /^#[0-9A-F]{6}([0-9A-F]{2})?$/i.test(value) ? value.toUpperCase() : null;
  };
  // The opacity of an Opacity Primitive (0 to 100) as two HEX digits, e.g. 12 -> "1F".
  const alphaHex = (name: string): string | null => {
    const v = prim.get(name);
    const value = v ? Object.values(v.values)[0] : undefined;
    if (typeof value !== "number") return null;
    return Math.round((Math.min(100, Math.max(0, value)) / 100) * 255).toString(16).padStart(2, "0").toUpperCase();
  };
  // A Theme token in one theme, resolved to HEX. An alpha token adds its opacity as two more digits.
  const themeHex = (name: string, themeMode: string): string | null => {
    const value = theme.get(name)?.values[themeMode];
    if (typeof value === "string") return value.toUpperCase(); // a color typed in by hand
    if (!value || typeof value !== "object") return null;
    // The color link names a Primitive; a color typed in by hand arrives as HEX instead.
    const base = value.alias.startsWith("#") ? value.alias.toUpperCase() : primHex(value.alias);
    if (!base) return null;
    if (value.opacityAlias === undefined) return base;
    const a = alphaHex(value.opacityAlias);
    return a === null ? null : base.slice(0, 7) + (a === "FF" ? "" : a);
  };
  return themeHex;
}

// Builds the export. problems lists every token that could not be resolved to a color, and every
// pair of tokens that would end up with the same export name; those tokens are left out.
export function buildAppearanceExport(source: TableSource, options: ExportOptions): { data: AppearanceExport; problems: string[] } {
  const problems: string[] = [];
  const data: AppearanceExport = { version: EXPORT_VERSION, themes: {} };
  const modesOf = (c: string): string[] => source.collections.find((x) => x.name === c)?.modes ?? [];
  const themeModes = modesOf("Theme");
  const appModes = modesOf("Appearance");
  if (appModes.length === 0) return { data, problems: ["There is no Appearance collection in this file. Generate tokens first."] };
  if (themeModes.length === 0) return { data, problems: ["There is no Theme collection in this file. Generate tokens first."] };

  const themeHex = themeResolver(source);
  const appearance = source.variables
    .filter((v) => v.collection === "Appearance" && v.type === "COLOR")
    .sort((a, b) => exportName(a.name, options).localeCompare(exportName(b.name, options), "en")); // the same order on every computer

  // Export names must be unique: two tokens with the same export name would overwrite each other.
  const seen = new Map<string, string>();
  const exported = appearance.filter((v) => {
    const key = exportName(v.name, options);
    const other = seen.get(key);
    if (other) {
      problems.push(`${v.name} and ${other} both become "${key}". ${v.name} was left out.`);
      return false;
    }
    seen.set(key, v.name);
    return true;
  });

  for (const t of themeModes) {
    const appearances: Record<string, Record<string, string>> = {};
    for (const m of appModes) {
      const tokens: Record<string, string> = {};
      for (const v of exported) {
        const value = v.values[m];
        const hex = typeof value === "string" ? value.toUpperCase()
          : value && typeof value === "object" ? themeHex(value.alias, t) : null;
        if (hex) tokens[exportName(v.name, options)] = hex;
        else problems.push(`${v.name} (${t}, ${m}) could not be resolved to a color and was left out.`);
      }
      appearances[m] = tokens;
    }
    data.themes[t] = { appearances };
  }
  return { data, problems };
}

// One exported file: its name and its contents. JSON files carry data; Kotlin files carry text.
export type ExportFile = { fileName: string; data?: AppearanceExport; text?: string };

// "all": one file with every theme. "perTheme": one file per theme, each with the same structure and
// only that theme, named after it ("Main theme" -> appearance-tokens-main-theme.json).
// prefix names the files: "appearance-tokens" (default) or "colorscheme-tokens".
export function exportFiles(data: AppearanceExport, split: "all" | "perTheme", prefix = "appearance-tokens"): ExportFile[] {
  if (split === "all") return [{ fileName: `${prefix}.json`, data }];
  const used = new Set<string>();
  return Object.entries(data.themes).map(([theme, content]) => {
    const slug = theme.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "theme";
    // Two theme names that differ only in punctuation or case would get the same file name.
    let fileName = `${prefix}-${slug}.json`;
    for (let n = 2; used.has(fileName); n++) fileName = `${prefix}-${slug}-${n}.json`;
    used.add(fileName);
    return { fileName, data: { version: data.version, themes: { [theme]: content } } };
  });
}

// ---------- ColorScheme (Android) ----------

// The ColorScheme export: the same shape as the Appearance export, with the Compose names as they are
// (primary, onPrimary, ...). dark tells, per theme and appearance, whether the scheme is a dark one:
// its surface color is dark (WCAG relative luminance below 0.18), so Dark-based extra appearances count too.
export function buildColorSchemeExport(source: TableSource): {
  data: AppearanceExport; dark: Record<string, Record<string, boolean>>; problems: string[];
} {
  const problems: string[] = [];
  const data: AppearanceExport = { version: EXPORT_VERSION, themes: {} };
  const dark: Record<string, Record<string, boolean>> = {};
  const modesOf = (c: string): string[] => source.collections.find((x) => x.name === c)?.modes ?? [];
  const themeModes = modesOf("Theme");
  const modes = modesOf("ColorScheme");
  if (modes.length === 0) return { data, dark, problems: ["There is no ColorScheme collection in this file. Generate tokens first."] };
  if (themeModes.length === 0) return { data, dark, problems: ["There is no Theme collection in this file. Generate tokens first."] };

  const themeHex = themeResolver(source);
  // In the file's order, which is the Compose order for the tokens this plugin created.
  const roles = source.variables.filter((v) => v.collection === "ColorScheme" && v.type === "COLOR");
  for (const t of themeModes) {
    const appearances: Record<string, Record<string, string>> = {};
    dark[t] = {};
    for (const m of modes) {
      const tokens: Record<string, string> = {};
      for (const v of roles) {
        const value = v.values[m];
        const hex = typeof value === "string" ? value.toUpperCase()
          : value && typeof value === "object" ? themeHex(value.alias, t) : null;
        if (hex) tokens[v.name] = hex;
        else problems.push(`${v.name} (${t}, ${m}) could not be resolved to a color and was left out.`);
      }
      appearances[m] = tokens;
      const surface = tokens.surface?.slice(0, 7);
      dark[t][m] = surface && isValidHex(surface) ? relativeLuminance(surface) < 0.18 : m === "Dark";
    }
    data.themes[t] = { appearances };
  }
  return { data, dark, problems };
}

// "Main theme" + "Light" -> "MainThemeLight": letters and digits only, each word capitalized.
function kotlinWord(text: string): string {
  return text.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

// "#RRGGBB" -> "Color(0xFFRRGGBB)", "#RRGGBBAA" -> "Color(0xAARRGGBB)" (Compose puts alpha first).
function kotlinColor(hex: string): string {
  const h = hex.replace("#", "").toUpperCase();
  return `Color(0x${h.length === 8 ? h.slice(6) + h.slice(0, 6) : "FF" + h})`;
}

const KOTLIN_PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const DEFAULT_KOTLIN_PACKAGE = "com.example.ui.theme";

// The package the user typed, or the default when it is not a valid Kotlin package name (reported).
function kotlinPackage(packageName: string, problems: string[]): string {
  const pkg = packageName.trim();
  if (KOTLIN_PACKAGE.test(pkg)) return pkg;
  problems.push(`"${pkg}" is not a valid Kotlin package name, so ${DEFAULT_KOTLIN_PACKAGE} was used.`);
  return DEFAULT_KOTLIN_PACKAGE;
}

// Two themes whose names differ only in punctuation would get the same file name: the second gets a number.
function uniqueKotlinFileNames(files: ExportFile[]): void {
  const seen = new Set<string>();
  for (const f of files) {
    const base = f.fileName.replace(/\.kt$/, "");
    for (let n = 2; seen.has(f.fileName); n++) f.fileName = `${base}${n}.kt`;
    seen.add(f.fileName);
  }
}

// Kotlin files for Jetpack Compose: one lightColorScheme(...) or darkColorScheme(...) value per theme and
// appearance, named like ThemeALightColorScheme. knownRoles is the list of Compose names the plugin
// creates (tokens.json colorScheme.tokens); a role added by hand in Figma would not compile, so it is left
// out and reported. split: "all" for one ColorSchemes.kt, "perTheme" for one file per theme.
export function kotlinFiles(
  exp: { data: AppearanceExport; dark: Record<string, Record<string, boolean>> },
  split: "all" | "perTheme", packageName: string, knownRoles: string[],
): { files: ExportFile[]; problems: string[] } {
  const problems: string[] = [];
  const pkg = kotlinPackage(packageName, problems);
  const unknown = new Set<string>();
  const usedNames = new Set<string>();
  // One "val ...ColorScheme = lightColorScheme(...)" per appearance of this theme.
  const schemesOf = (theme: string): string => Object.entries(exp.data.themes[theme].appearances).map(([mode, tokens]) => {
    // A Kotlin name cannot start with a digit ("2024 Light"), so such a name starts with "Scheme". A number
    // added to tell two names apart goes after that start, so the name stays valid.
    const word = `${kotlinWord(theme)}${kotlinWord(mode)}`;
    const base = /^[A-Za-z]/.test(word) ? word : `Scheme${word}`;
    let name = `${base}ColorScheme`;
    for (let n = 2; usedNames.has(name); n++) name = `${base}${n}ColorScheme`;
    usedNames.add(name);
    const args: string[] = [];
    for (const [role, hex] of Object.entries(tokens)) {
      if (knownRoles.includes(role)) args.push(`    ${role} = ${kotlinColor(hex)},`);
      else unknown.add(role);
    }
    const fn = exp.dark[theme]?.[mode] ? "darkColorScheme" : "lightColorScheme";
    return `// ${theme}, ${mode}\nval ${name} = ${fn}(\n${args.join("\n")}\n)\n`;
  }).join("\n");
  const header = `// Generated by the Tokenseed Figma plugin from the ColorScheme variables. Do not edit by hand.\n` +
    `package ${pkg}\n\nimport androidx.compose.material3.darkColorScheme\nimport androidx.compose.material3.lightColorScheme\n` +
    `import androidx.compose.ui.graphics.Color\n\n`;
  const themes = Object.keys(exp.data.themes);
  const files: ExportFile[] = split === "all"
    ? [{ fileName: "ColorSchemes.kt", text: header + themes.map(schemesOf).join("\n") }]
    : themes.map((t) => ({ fileName: `${kotlinWord(t) || "Theme"}ColorScheme.kt`, text: header + schemesOf(t) }));
  uniqueKotlinFileNames(files);
  for (const role of unknown) problems.push(`${role} is not a Compose ColorScheme role, so it was left out of the Kotlin file.`);
  return { files, problems };
}

// ---------- Appearance tokens as Kotlin ----------

// Kotlin words that cannot be used as a property name.
const KOTLIN_KEYWORDS = new Set(["as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in",
  "interface", "is", "null", "object", "package", "return", "super", "this", "throw", "true", "try", "typealias",
  "typeof", "val", "var", "when", "while"]);
const APPEARANCE_CLASS = "AppearanceColors";

// Kotlin files for Jetpack Compose with the Appearance tokens. data is the Appearance export built with camelCase
// names (buildAppearanceExport with naming "camel"), so every token name is a Kotlin property name.
// The files hold one class, AppearanceColors, with one Color property per token, and one value of it per theme
// and appearance, named like MainThemeLightAppearanceColors. Every value must give every property, so a token
// missing from any theme or appearance (it could not be resolved) is left out of all of them, and reported.
// A name that is not a valid Kotlin property name (a token added by hand in Figma) is left out and reported.
// split: "all" for one AppearanceColors.kt with the class and every value; "perTheme" for AppearanceColors.kt
// with the class only, plus one file per theme with its values.
export function appearanceKotlinFiles(
  data: AppearanceExport, split: "all" | "perTheme", packageName: string,
): { files: ExportFile[]; problems: string[] } {
  const problems: string[] = [];
  const pkg = kotlinPackage(packageName, problems);
  const themes = Object.keys(data.themes);
  const sets = themes.flatMap((t) => Object.values(data.themes[t].appearances).map((tokens) => Object.keys(tokens)));
  if (sets.length === 0) return { files: [], problems };

  // The properties: tokens present in every theme and appearance, in the export's (alphabetical) order.
  const everyName = [...new Set(sets.flat())];
  const properties = everyName.filter((name) => {
    if (!/^[a-z][A-Za-z0-9]*$/.test(name) || KOTLIN_KEYWORDS.has(name)) {
      problems.push(`${name} is not a valid Kotlin property name, so it was left out of the Kotlin file.`);
      return false;
    }
    if (!sets.every((names) => names.includes(name))) {
      problems.push(`${name} is missing in at least one theme or appearance, so it was left out of the Kotlin file.`);
      return false;
    }
    return true;
  });
  // A data class needs at least one property, so with none there is no Kotlin file to make.
  if (properties.length === 0) {
    problems.push("No Appearance token can be written as a Kotlin property, so no Kotlin file was made.");
    return { files: [], problems };
  }

  const header = (imports: string[]): string => `// Generated by the Tokenseed Figma plugin from the Appearance variables. Do not edit by hand.\n` +
    `package ${pkg}\n\n${imports.map((i) => `import ${i}\n`).join("")}\n`;
  const classText = `// One Color per Appearance token. Each theme and appearance is a value of this class.\n@Immutable\n` +
    `data class ${APPEARANCE_CLASS}(\n${properties.map((p) => `    val ${p}: Color,`).join("\n")}\n)\n`;
  const usedNames = new Set<string>();
  // One "val ...AppearanceColors = AppearanceColors(...)" per appearance of this theme.
  const valuesOf = (theme: string): string => Object.entries(data.themes[theme].appearances).map(([mode, tokens]) => {
    // As in the ColorScheme Kotlin: a name that would start with a digit starts with "Theme", before any number.
    const word = `${kotlinWord(theme)}${kotlinWord(mode)}`;
    const base = /^[A-Za-z]/.test(word) ? word : `Theme${word}`;
    let name = `${base}${APPEARANCE_CLASS}`;
    for (let n = 2; usedNames.has(name); n++) name = `${base}${n}${APPEARANCE_CLASS}`;
    usedNames.add(name);
    return `// ${theme}, ${mode}\nval ${name} = ${APPEARANCE_CLASS}(\n${properties.map((p) => `    ${p} = ${kotlinColor(tokens[p])},`).join("\n")}\n)\n`;
  }).join("\n");

  const classImports = ["androidx.compose.runtime.Immutable", "androidx.compose.ui.graphics.Color"];
  const files: ExportFile[] = split === "all"
    ? [{ fileName: `${APPEARANCE_CLASS}.kt`, text: header(classImports) + classText + "\n" + themes.map(valuesOf).join("\n") }]
    : [
      { fileName: `${APPEARANCE_CLASS}.kt`, text: header(classImports) + classText },
      ...themes.map((t) => ({ fileName: `${kotlinWord(t) || "Theme"}${APPEARANCE_CLASS}.kt`, text: header(["androidx.compose.ui.graphics.Color"]) + valuesOf(t) })),
    ];
  uniqueKotlinFileNames(files);
  return { files, problems };
}
