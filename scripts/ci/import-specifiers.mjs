// check:patterns gate 10 (M5b): the module specifiers a JS/TS source file loads, read after
// comments are dropped and every string, template and regular-expression literal is replaced by
// a placeholder. So an import written in a comment, or import-looking text inside a string,
// counts as nothing. Plain Node, no dependency; a heuristic lexer, not a parser (JSX text with a
// lone quote can hide the rest of that line).

const IDENT = /[A-Za-z0-9_$]/;
/** After these characters a `/` starts a regular expression, not a division. */
const BEFORE_REGEX = new Set([
    '',
    '(',
    ',',
    '=',
    ':',
    '[',
    '!',
    '&',
    '|',
    '?',
    '{',
    '}',
    ';',
    '+',
    '-',
    '*',
    '%',
    '<',
    '>',
    '~',
    '^',
]);
const KEYWORD_BEFORE_REGEX =
    /^(?:return|typeof|case|do|else|in|of|void|yield|await|delete|instanceof|new|throw)$/;

/**
 * `code` is the source with comments removed and each literal replaced by `'@@S<n>@@'`;
 * `literals[n]` is that literal's text (escapes resolved loosely; each `${…}` of a template
 * becomes `*`). Regular-expression literals become `/re/` and are not recorded.
 */
export function lexSource(text) {
    let out = '';
    const literals = [];
    let lastSig = '';
    let word = '';
    let lastWord = '';
    const emitLiteral = (value) => {
        literals.push(value);
        out += `'@@S${literals.length - 1}@@'`;
        lastSig = "'";
        lastWord = '';
        word = '';
    };
    const n = text.length;
    let i = 0;
    while (i < n) {
        const c = text[i];
        const d = text[i + 1];
        if (c === '/' && d === '/') {
            while (i < n && text[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && d === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end < 0 ? n : end + 2;
            out += ' ';
            continue;
        }
        if (c === '"' || c === "'") {
            let j = i + 1;
            let value = '';
            while (j < n && text[j] !== c && text[j] !== '\n') {
                if (text[j] === '\\') {
                    value += text[j + 1] ?? '';
                    j += 2;
                } else value += text[j++];
            }
            i = j + 1;
            emitLiteral(value);
            continue;
        }
        if (c === '`') {
            let j = i + 1;
            let value = '';
            while (j < n && text[j] !== '`') {
                if (text[j] === '\\') {
                    value += text[j + 1] ?? '';
                    j += 2;
                } else if (text[j] === '$' && text[j + 1] === '{') {
                    let depth = 1;
                    j += 2;
                    while (j < n && depth > 0) {
                        if (text[j] === '{') depth++;
                        else if (text[j] === '}') depth--;
                        j++;
                    }
                    value += '*';
                } else value += text[j++];
            }
            i = j + 1;
            emitLiteral(value);
            continue;
        }
        if (c === '/' && (BEFORE_REGEX.has(lastSig) || KEYWORD_BEFORE_REGEX.test(lastWord))) {
            let j = i + 1;
            let inClass = false;
            while (j < n && text[j] !== '\n') {
                const ch = text[j];
                if (ch === '\\') {
                    j += 2;
                    continue;
                }
                if (ch === '[') inClass = true;
                else if (ch === ']') inClass = false;
                else if (ch === '/' && !inClass) break;
                j++;
            }
            j++;
            while (j < n && /[a-z]/i.test(text[j])) j++;
            i = j;
            out += ' /re/ ';
            lastSig = '/';
            lastWord = '';
            word = '';
            continue;
        }
        out += c;
        if (IDENT.test(c)) {
            word += c;
            lastSig = c;
        } else {
            if (word !== '') lastWord = word;
            word = '';
            if (!/\s/.test(c)) {
                lastSig = c;
                lastWord = '';
            }
        }
        i++;
    }
    return { code: out, literals };
}

const LIT = String.raw`'@@S(\d+)@@'`;

/** `import { type A, type B }` and `import type …` load nothing at run time. */
function isTypeOnlyClause(keyword, clause) {
    if (/^type\s/.test(clause)) return true;
    const named = /^\{([^}]*)\}$/.exec(clause);
    if (!named) return false;
    const parts = named[1]
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
    return keyword === 'import' && parts.length > 0 && parts.every((p) => /^type\s/.test(p));
}

/**
 * Every specifier the file loads: `kind` is `static` (import / export … from, side-effect
 * import), `dynamic` (`import()` with a string or template literal), `require`, or `glob`
 * (`import.meta.glob` / `globEager` patterns, a leading `!` dropped). A call whose argument is
 * not a literal (`import(x)`, `tsImport('…')`) is not an import.
 */
export function importSpecifiers(text) {
    const { code, literals } = lexSource(text);
    const lit = (index) => literals[Number(index)] ?? '';
    const found = [];
    for (const m of code.matchAll(
        new RegExp(String.raw`\b(import|export)\b([^;'"]*?)\bfrom\s*${LIT}`, 'g'),
    )) {
        const clause = m[2].trim();
        found.push({ spec: lit(m[3]), kind: 'static', typeOnly: isTypeOnlyClause(m[1], clause) });
    }
    for (const m of code.matchAll(new RegExp(String.raw`\bimport\s*${LIT}`, 'g'))) {
        found.push({ spec: lit(m[1]), kind: 'static', typeOnly: false });
    }
    for (const m of code.matchAll(new RegExp(String.raw`(?<![.\w$])import\s*\(\s*${LIT}`, 'g'))) {
        found.push({ spec: lit(m[1]), kind: 'dynamic', typeOnly: false });
    }
    for (const m of code.matchAll(new RegExp(String.raw`(?<![.\w$])require\s*\(\s*${LIT}`, 'g'))) {
        found.push({ spec: lit(m[1]), kind: 'require', typeOnly: false });
    }
    for (const m of code.matchAll(/\bimport\s*\.\s*meta\s*\.\s*glob(?:Eager)?\s*\(([^)]*)\)/g)) {
        for (const g of m[1].matchAll(new RegExp(LIT, 'g'))) {
            found.push({ spec: lit(g[1]).replace(/^!/, ''), kind: 'glob', typeOnly: false });
        }
    }
    return found;
}
