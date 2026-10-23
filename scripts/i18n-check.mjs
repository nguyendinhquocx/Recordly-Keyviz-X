import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const localesDir = path.join(root, "src", "i18n", "locales");

const locales = fs
	.readdirSync(localesDir)
	.filter((entry) => {
		const fullPath = path.join(localesDir, entry);
		return fs.statSync(fullPath).isDirectory();
	})
	.sort((left, right) => left.localeCompare(right));

if (!locales.includes("en")) {
	console.error('i18n-check: expected base locale directory "en"');
	process.exit(1);
}

function loadJson(filePath) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`i18n-check: failed to load ${path.relative(root, filePath)}: ${message}`);
	}
}

function collectKeyPaths(obj, prefix = "") {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
		return prefix ? [prefix] : [];
	}

	const keys = Object.keys(obj);
	if (keys.length === 0) {
		return prefix ? [prefix] : [];
	}

	const paths = [];
	for (const key of keys) {
		const nextPrefix = prefix ? `${prefix}.${key}` : key;
		const value = obj[key];
		if (value && typeof value === "object" && !Array.isArray(value)) {
			paths.push(...collectKeyPaths(value, nextPrefix));
		} else {
			paths.push(nextPrefix);
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
		if (locale === "en") continue;

		const localeFile = path.join(localesDir, locale, namespaceFile);
		if (!fs.existsSync(localeFile)) {
			console.error(`i18n-check: missing namespace file ${locale}/${namespaceFile}`);
			hasErrors = true;
			continue;
		}

		const localeData = loadJson(localeFile);
		const localeKeys = new Set(collectKeyPaths(localeData));

		for (const key of baseKeys) {
			if (!localeKeys.has(key)) {
				console.error(`i18n-check: missing key ${locale}/${namespaceFile}:${key}`);
				hasErrors = true;
			}
		}

		for (const key of localeKeys) {
			if (!baseKeys.has(key)) {
				console.error(`i18n-check: extra key ${locale}/${namespaceFile}:${key}`);
				hasErrors = true;
			}
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

if (hasErrors) {
	process.exit(1);
}

console.log("i18n-check: locale files are structurally consistent");
