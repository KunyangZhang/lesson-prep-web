import assert from "node:assert/strict";
import test from "node:test";
import { calendarMonth, dayKey, lessonClock, lessonDate, monthDays } from "../src/features/courses/schedule.js";

process.env.TZ = "Asia/Shanghai";

test("missing and invalid lesson dates stay unscheduled", () => {
  for (const value of ["", " ", "尚未确定", "2026-02-30T09:00", "2026-13-01T09:00", "2026-01-01T25:00"]) {
    assert.equal(lessonDate(value), null, value);
  }
  assert.equal(lessonClock(""), "待安排");
});

test("local lesson dates keep their teaching day and clock", () => {
  assert.equal(dayKey(lessonDate("2026-10-20T09:05")!), "2026-10-20");
  assert.equal(lessonClock("2026-10-20T09:05"), "09:05");
  assert.equal(dayKey(lessonDate("2026-10-20")!), "2026-10-20");
  assert.equal(dayKey(lessonDate("2026-10-20T17:30:00Z")!), "2026-10-21");
});

test("month navigation handles a 31st day and year boundaries", () => {
  assert.equal(dayKey(calendarMonth(new Date(2026, 0, 31), 1)), "2026-02-01");
  assert.equal(dayKey(calendarMonth(new Date(2026, 11, 31), 1)), "2027-01-01");
  assert.equal(dayKey(calendarMonth(new Date(2026, 0, 1), -1)), "2025-12-01");
});

test("calendar grid starts on Monday and includes every day of a leap February", () => {
  const days = monthDays(new Date(2024, 1, 1));
  assert.equal(days.length, 42);
  assert.equal(days[0]!.getDay(), 1);
  assert.equal(dayKey(days[0]!), "2024-01-29");
  assert.equal(days.filter((day) => day.getMonth() === 1).length, 29);
  assert.equal(days.filter((day) => dayKey(day) === "2024-02-29").length, 1);
});

test("a month starting on Sunday retains its leading Monday and adjacent year dates", () => {
  const march = monthDays(new Date(2026, 2, 1));
  assert.equal(dayKey(march[0]!), "2026-02-23");
  assert.equal(march.filter((day) => day.getMonth() === 2).length, 31);
  const january = monthDays(new Date(2027, 0, 1));
  assert.equal(dayKey(january[0]!), "2026-12-28");
});
