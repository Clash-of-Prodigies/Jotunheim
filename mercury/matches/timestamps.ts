const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

export function normalizeScheduledAt(value: string): string | null {
    const match = TIMESTAMP_PATTERN.exec(value);
    if (match === null) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
    const zone = match[8];

    if (
        month < 1 || month > 12
        || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
        || hour > 23 || minute > 59 || second > 59
        || zone === undefined
    ) {
        return null;
    }

    let offsetMinutes = 0;
    if (zone !== "Z") {
        const sign = zone[0] === "+" ? 1 : -1;
        const offsetHours = Number(zone.slice(1, 3));
        const offsetRemainder = Number(zone.slice(4, 6));
        if (offsetHours > 23 || offsetRemainder > 59) return null;
        offsetMinutes = sign * (offsetHours * 60 + offsetRemainder);
    }

    const epoch = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
        - offsetMinutes * 60_000;
    const date = new Date(epoch);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function isCanonicalUtcTimestamp(value: string): boolean {
    return normalizeScheduledAt(value) === value;
}