export function dayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function lessonDate(value: string) {
  if (!value.trim()) return null;
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (local) {
    const date = new Date(Number(local[1]), Number(local[2]) - 1, Number(local[3]), Number(local[4] || 0), Number(local[5] || 0), Number(local[6] || 0));
    return dayKey(date) === local.slice(1, 4).join("-") && date.getHours() === Number(local[4] || 0) && date.getMinutes() === Number(local[5] || 0) && date.getSeconds() === Number(local[6] || 0) ? date : null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function monthDays(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => new Date(first.getFullYear(), first.getMonth(), 1 - mondayOffset + index));
}

export function calendarMonth(date: Date, offset = 0) {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1);
}

export function lessonClock(value: string) {
  const date = lessonDate(value);
  return date ? `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` : "待安排";
}
