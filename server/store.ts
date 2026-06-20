import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { Course, Db, Job, Material, Student, User } from "./types.js";

const emptyDb = (): Db => ({
  users: [],
  students: [],
  courses: [],
  jobs: [],
  materials: [],
  ragChunks: []
});

export class Store {
  private dbPath: string;
  data: Db;

  constructor(dbPath = path.join(config.dataDir, "app-db.json")) {
    this.dbPath = dbPath;
    this.data = this.load();
  }

  reload() {
    this.data = this.load();
  }

  save() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const tmpPath = `${this.dbPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmpPath, this.dbPath);
  }

  private load(): Db {
    if (!fs.existsSync(this.dbPath)) return emptyDb();
    const parsed = JSON.parse(fs.readFileSync(this.dbPath, "utf8")) as Partial<Db>;
    return { ...emptyDb(), ...parsed };
  }

  findUserByUsername(username: string) {
    return this.data.users.find((user) => user.username.toLowerCase() === username.toLowerCase());
  }

  findUserById(id: string) {
    return this.data.users.find((user) => user.id === id);
  }

  findStudent(id: string) {
    return this.data.students.find((student) => student.id === id);
  }

  findCourse(id: string) {
    return this.data.courses.find((course) => course.id === id);
  }

  findJob(id: string) {
    return this.data.jobs.find((job) => job.id === id);
  }

  addUser(user: User) {
    this.data.users.push(user);
    this.save();
  }

  addStudent(student: Student) {
    this.data.students.push(student);
    this.save();
  }

  addCourse(course: Course) {
    this.data.courses.push(course);
    this.save();
  }

  addJob(job: Job) {
    this.data.jobs.push(job);
    this.save();
  }

  deleteCourse(courseId: string) {
    const course = this.findCourse(courseId);
    if (!course) return false;
    this.data.courses = this.data.courses.filter((item) => item.id !== courseId);
    this.data.jobs = this.data.jobs.filter((job) => job.courseId !== courseId);
    this.save();
    return true;
  }

  deleteStudent(studentId: string) {
    const student = this.findStudent(studentId);
    if (!student) return false;
    const courseIds = new Set(this.data.courses.filter((course) => course.studentId === studentId).map((course) => course.id));
    this.data.students = this.data.students.filter((item) => item.id !== studentId);
    this.data.courses = this.data.courses.filter((course) => course.studentId !== studentId);
    this.data.jobs = this.data.jobs.filter((job) => !courseIds.has(job.courseId));
    this.save();
    return true;
  }

  upsertMaterial(material: Material) {
    const index = this.data.materials.findIndex((item) => item.id === material.id);
    if (index >= 0) this.data.materials[index] = material;
    else this.data.materials.push(material);
    this.save();
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function hashId(input: string) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

export function sanitizeFilename(input: string, fallback = "untitled") {
  const cleaned = input
    .replace(/[<>:"/\\|?*\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

export function decodeUploadName(input: string) {
  try {
    const decoded = Buffer.from(input, "latin1").toString("utf8");
    const cjkCount = (value: string) => (value.match(/[\u3400-\u9fff]/g) || []).length;
    const badCount = (value: string) => (value.match(/[�ÃÂ]|[\u0080-\u009F]|[äåæçèé][\u0080-\u00ff]?/g) || []).length;
    if (!decoded.includes("�") && (cjkCount(decoded) > cjkCount(input) || badCount(decoded) < badCount(input))) {
      return decoded;
    }
    return input;
  } catch {
    return input;
  }
}

export function safeRelativeUploadPath(input: string) {
  const decoded = decodeUploadName(input).replace(/\\/g, "/");
  const parts = decoded
    .split("/")
    .map((part) => sanitizeFilename(part, "untitled"))
    .filter((part) => part && part !== "." && part !== "..");
  return parts.length > 0 ? path.join(...parts) : sanitizeFilename(decoded, "upload");
}

export function publicCourse(course: Course) {
  return {
    ...course,
    outputDir: course.outputDir
  };
}
