import type { Token, TokenizerThis, RendererThis } from 'marked';

/** Typora-style highlight. Keep the original delimiters in the editor state. */
export default function markExtension() {
    return {
        extensions: [{
            name: 'mark',
            level: 'inline' as const,
            start(src: string) { return src.indexOf('=='); },
            tokenizer(this: TokenizerThis, src: string) {
                const match = /^==(?!=)(?=\S)((?:\\.|[^\n])*?\S)(?<!\\)==(?!=)/.exec(src);
                if (!match) return;
                return { type: 'mark', raw: match[0], tokens: this.lexer.inlineTokens(match[1]) };
            },
            renderer(this: RendererThis, token: { tokens: Token[] }) {
                return `<mark>${this.parser.parseInline(token.tokens)}</mark>`;
            },
        }],
    };
}
