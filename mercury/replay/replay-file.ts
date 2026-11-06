export function parseCsv(content: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < content.length; index += 1) {
        const character = content[index];
        if (quoted) {
            if (character === '"') {
                if (content[index + 1] === '"') {
                    field += '"';
                    index += 1;
                } else quoted = false;
            } else field += character;
            continue;
        }
        if (character === '"' && field.length === 0) quoted = true;
        else if (character === ",") {
            row.push(field);
            field = "";
        } else if (character === "\n") {
            row.push(field.replace(/\r$/, ""));
            if (row.some((value) => value.length > 0)) rows.push(row);
            row = [];
            field = "";
        } else field += character;
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field.replace(/\r$/, ""));
        rows.push(row);
    }
    return rows;
}

export function csvObjects(content: string): Array<Record<string, string>> {
    const [headers, ...rows] = parseCsv(content);
    if (headers === undefined) return [];
    return rows.map((row) => Object.fromEntries(
        headers.map((header, index) => [header, row[index] ?? ""]),
    ));
}
