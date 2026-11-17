import { DiscordError } from './discord-channels.js';

export const sourceParameter = {
  type: 'string',
  minLength: 1,
  maxLength: 1024,
  description:
    'Known source URL or client/session label, displayed in the thread caption only. Omit if unknown; never invent it.',
};

/** Render untrusted attribution as visible text, keeping only channel tags and raw URLs active. */
export function displaySource(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ||
    new TextDecoder().decode(new TextEncoder().encode(value)) !== value
  )
    throw new DiscordError('SOURCE_INVALID');

  // Do not decode entities: reject them so encoded tags/controls cannot change interpretation.
  if (
    /&(?:#(?:[xX][0-9a-fA-F]+|[0-9]+);?|[a-zA-Z][a-zA-Z0-9]*;|(?:lt|gt|amp|quot)(?![a-zA-Z0-9=]))/i.test(
      value
    )
  )
    throw new DiscordError('SOURCE_INVALID');

  // Quotes may contain >. Preserve Discord channel tags and angle URLs before stripping HTML.
  const stripped = value.replace(
    /<#[1-9][0-9]{16,19}>|<[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^<>\s]+>|<!--[\s\S]*?(?:-->|$)|<![^>]*(?:>|$)|<\/?[a-zA-Z][a-zA-Z0-9:-]*(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*(?:>|$)/g,
    (token) => (/^<(?:#|[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)/.test(token) ? token : '')
  );
  const escapeText = (text: string) =>
    text.replace(/@/g, '@\u200b').replace(/[\\\x60*_{}[\]()|~<>]/g, '\\$&');
  const displayText = (input: string): string =>
    input.replace(
      /<#[1-9][0-9]{16,19}>|<[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^<>\s]+>|https?:\/\/[^<>\s\\\x60]+|[^]/gi,
      (token, offset: number) => {
        if (/^<#[1-9][0-9]{16,19}>$/.test(token)) return token;
        const text = token.startsWith('<') && token.length > 1 ? token.slice(1, -1) : token;
        if (!/^https?:\/\//i.test(text)) return escapeText(text);

        // Keep URL bytes intact without swallowing surrounding Markdown syntax.
        let end = text.search(/\[[^\]]*\]\(/);
        if (end < 0) end = text.length;
        if (!token.startsWith('<')) {
          const prefix = input.slice(0, offset);
          const wrappers = prefix.match(/[\x60*_~|]+$/)?.[0] ?? '';
          while (end > 0 && wrappers.includes(text[end - 1])) end--;
          const open = prefix.slice(-1);
          const close = open === '(' ? ')' : open === '[' ? ']' : '';
          if (close) {
            let depth = 0;
            for (let i = 0; i < end; i++) {
              if (text[i] === open) depth++;
              if (text[i] === close && depth-- === 0) {
                end = i;
                break;
              }
            }
          }
        }
        // Discord broadcasts remain inert even when appended to a URL.
        return (
          text.slice(0, end).replace(/@(everyone|here)/g, '@\u200b$1') +
          displayText(text.slice(end))
        );
      }
    );
  const displayed = displayText(stripped).trim();
  if (!displayed || displayed.length > 1600) throw new DiscordError('SOURCE_INVALID');
  return displayed;
}
