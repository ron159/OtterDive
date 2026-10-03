/** Basic labelled display equations; source text is never rewritten. */
export function collectEquationLabels(markdown: string): Record<string, string> {
    const labels: Record<string, string> = Object.create(null);
    let fence = '';
    let mathFence = false;
    let math = false;
    let source = '';
    let equation = 0;
    const recordEquation = () => {
        equation += 1;
        const tag = /\\tag\*?\{([^{}]+)\}/.exec(source)?.[1] ?? String(equation);
        for (const match of source.matchAll(/\\label\{([^{}]+)\}/g)) {
            if (!Object.hasOwn(labels, match[1])) labels[match[1]] = tag;
        }
    };
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    if (lines[0] === '---' || lines[0] === '+++') {
        const end = lines.indexOf(lines[0], 1);
        if (end > 0) lines.splice(0, end + 1);
    }
    for (const line of lines) {
        const codeFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
            if (codeFence && codeFence[1][0] === fence[0] && codeFence[1].length >= fence.length && !codeFence[2].trim()) {
                if (mathFence) recordEquation();
                fence = '';
                source = '';
            } else if (mathFence) source += `${line}\n`;
            continue;
        }
        if (!math && codeFence) {
            fence = codeFence[1];
            mathFence = codeFence[2].trim() === 'math';
            source = '';
            continue;
        }
        if (/^\s*\$\$\s*$/.test(line)) {
            if (math) {
                recordEquation();
            }
            source = '';
            math = !math;
        } else if (math) source += `${line}\n`;
    }
    return { ...labels };
}

function safeText(value: string) {
    return value.replace(/[\\{}%$&#_^~]/g, '');
}

export function prepareEquationTex(tex: string, labels: Record<string, string>, displayMode: boolean) {
    const ownLabel = /\\label\{([^{}]+)\}/.exec(tex)?.[1];
    let result = tex.replace(/\\label\{[^{}]+\}/g, '').replace(/\\(eqref|ref)\{([^{}]+)\}/g, (_, kind: string, label: string) => {
        const value = Object.hasOwn(labels, label) ? safeText(labels[label]) : '??';
        return `\\text{${kind === 'eqref' && value !== '??' ? `(${value})` : value}}`;
    });
    if (displayMode && ownLabel && Object.hasOwn(labels, ownLabel) && !/\\tag\*?\{/.test(result)) {
        result += `\\tag{${safeText(labels[ownLabel])}}`;
    }
    return result;
}
