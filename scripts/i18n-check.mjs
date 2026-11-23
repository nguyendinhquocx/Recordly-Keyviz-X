import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { auditSourceKeys } from "./i18n-source-check.mjs";

const root = process.cwd();
const localesDir = path.join(root, "src/i18n/locales");
const source = ts.createSourceFile(
	"config.ts",
	fs.readFileSync(path.join(root, "src/i18n/config.ts"), "utf8"),
	ts.ScriptTarget.Latest,
	true,
);
const arrays = {};
function readConfig(node) {
	if (ts.isVariableDeclaration(node) && node.initializer) {
		const value = ts.isAsExpression(node.initializer)
			? node.initializer.expression
			: node.initializer;
		if (ts.isArrayLiteralExpression(value))
			arrays[node.name.getText(source)] = value.elements.map((entry) => entry.text);
	}
	ts.forEachChild(node, readConfig);
}
readConfig(source);
const locales = arrays.SUPPORTED_LOCALES;
const namespaces = arrays.I18N_NAMESPACES;
if (!locales?.includes("en") || !namespaces?.length)
	throw Error("i18n-check: invalid runtime locale configuration");

function flatten(object, prefix = "", result = {}) {
	for (const [key, value] of Object.entries(object)) {
		const name = prefix ? `${prefix}.${key}` : key;
		if (value && typeof value === "object" && !Array.isArray(value))
			flatten(value, name, result);
		else result[name] = value;
	}
	return result;
}
function tokens(value) {
	return [...value.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)]
		.map((match) => match[1])
		.sort()
		.join(",");
}
let errors = 0;
const report = (message) => {
	console.error(`i18n-check: ${message}`);
	errors++;
};
const baseCatalogs = {};
for (const namespace of namespaces) {
	const load = (locale) => {
		const file = path.join(localesDir, locale, `${namespace}.json`);
		try {
			return flatten(JSON.parse(fs.readFileSync(file, "utf8")));
		} catch (error) {
			report(`cannot load ${locale}/${namespace}.json: ${error.message}`);
			return {};
		}
	}
	return paths;
}

const baseLocaleDir = path.join(localesDir, "en");
const namespaceFiles = fs
	.readdirSync(baseLocaleDir)
	.filter((file) => file.endsWith(".json"))
	.sort((left, right) => left.localeCompare(right));

let hasErrors = false;

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function collectPlaceholders(value) {
	if (typeof value !== "string") return new Set();
	const found = new Set();
	for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
		found.add(match[1]);
	}
	return found;
}

function collectLeafEntries(obj, prefix = "", into = []) {
	if (obj && typeof obj === "object" && !Array.isArray(obj)) {
		for (const [key, value] of Object.entries(obj)) {
			collectLeafEntries(value, prefix ? `${prefix}.${key}` : key, into);
		}
		return into;
	}
	into.push([prefix, obj]);
	return into;
}

for (const namespaceFile of namespaceFiles) {
	const baseData = loadJson(path.join(baseLocaleDir, namespaceFile));
	const baseKeys = new Set(collectKeyPaths(baseData));
	const baseEntries = new Map(collectLeafEntries(baseData));

	for (const locale of locales) {
		const data = locale === "en" ? base : load(locale);
		for (const [key, value] of Object.entries(base)) {
			const translated = data[key];
			if (translated === undefined) {
				report(`missing key ${locale}/${namespace}.json:${key}`);
				continue;
			}
			if (typeof translated !== "string" || !translated.trim()) {
				report(`empty or non-string value ${locale}/${namespace}.json:${key}`);
				continue;
			}
			if (typeof value === "string" && tokens(value) !== tokens(translated))
				report(`placeholder mismatch ${locale}/${namespace}.json:${key}`);
			if (
				locale !== "en" &&
				value === translated &&
				value.trim().split(/\s+/).length >= 5 &&
				/[A-Za-z]/.test(value)
			)
				report(`untranslated English sentence ${locale}/${namespace}.json:${key}`);
		}
		for (const key of Object.keys(data)) {
			if (!Object.hasOwn(base, key)) report(`extra key ${locale}/${namespace}.json:${key}`);
		}

		// Interpolation placeholder parity: a translated string must consume the
		// exact same {{placeholders}} as the base locale, otherwise runtime calls
		// with vars silently render unfilled templates.
		for (const [key, baseValue] of baseEntries) {
			if (typeof baseValue !== "string") continue;
			const basePlaceholders = collectPlaceholders(baseValue);
			if (basePlaceholders.size === 0) continue;
			const localeValue = localeData;
			let cursor = localeValue;
			let missingPath = false;
			for (const part of key.split(".")) {
				if (cursor && typeof cursor === "object" && part in cursor) {
					cursor = cursor[part];
				} else {
					missingPath = true;
					break;
				}
			}
			if (missingPath || typeof cursor !== "string") continue;
			const localePlaceholders = collectPlaceholders(cursor);
			for (const placeholder of basePlaceholders) {
				if (!localePlaceholders.has(placeholder)) {
					console.error(
						`i18n-check: missing placeholder {{${placeholder}}} in ${locale}/${namespaceFile}:${key}`,
					);
					hasErrors = true;
				}
			}
			for (const placeholder of localePlaceholders) {
				if (!basePlaceholders.has(placeholder)) {
					console.error(
						`i18n-check: extra placeholder {{${placeholder}}} in ${locale}/${namespaceFile}:${key}`,
					);
					hasErrors = true;
				}
			}
		}
	}
}
const sourceAudit = auditSourceKeys(baseCatalogs);
for (const missing of sourceAudit.missing)
	report(`source key missing ${missing.file}:${missing.line} ${missing.key}`);
if (errors) process.exit(1);
console.log(
	`i18n-check: ${locales.length} supported languages × ${namespaces.length} namespaces have complete keys, nonempty strings and matching placeholders; ${sourceAudit.translatorCalls} source calls checked, no untranslated English sentences`,
);
