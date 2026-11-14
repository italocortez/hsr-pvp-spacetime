// Cookie reading and writing for the login function. Every cookie it sets carries the `__Host-`
// prefix rules: Secure, Path=/, no Domain.

export interface CookieOptions {
    maxAge: number;
    httpOnly: boolean;
    sameSite: 'Strict' | 'Lax';
}

/** A `Set-Cookie` value. `value` must already be cookie-safe (base64url or percent-encoded). */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
    const parts = [`${name}=${value}`, 'Path=/', `Max-Age=${opts.maxAge}`, 'Secure'];
    if (opts.httpOnly) parts.push('HttpOnly');
    parts.push(`SameSite=${opts.sameSite}`);
    return parts.join('; ');
}

/** A `Set-Cookie` value that deletes `name` (same attributes, empty value, Max-Age=0). */
export function clearCookie(name: string, opts: Omit<CookieOptions, 'maxAge'>): string {
    return serializeCookie(name, '', { ...opts, maxAge: 0 });
}

/** The value of `name` in a `Cookie` request header, or undefined. The first one wins. */
export function readCookie(header: string | null, name: string): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return undefined;
}
