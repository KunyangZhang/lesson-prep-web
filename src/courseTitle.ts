/** A compact display label; the full preparation request stays on the course. */
export function shortCourseTitle(value = "", maxLength = 24) {
  const firstLine = value.replace(/\s+/g, " ").trim().split(/[：:。；;]/)[0]
    .replace(/(?:[一二三四五六七八九十\d]+大)?专题题型全覆盖$/, "")
    .replace(/[,，、\s]+$/, "");
  const characters = Array.from(firstLine || value.trim() || "未命名课程");
  return characters.length > maxLength ? `${characters.slice(0, maxLength - 1).join("")}…` : characters.join("");
}
