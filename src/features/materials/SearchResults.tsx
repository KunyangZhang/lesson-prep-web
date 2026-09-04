import { BookOpenText, FileQuestion, Tags } from "lucide-react";
import type { RagSearchResult, RagSourceKind } from "../../types";

function sourceLabel(kind: RagSourceKind) {
  const labels: Record<RagSourceKind, string> = {
    exam: "真题",
    mock: "模考",
    local: "本地题",
    adapted: "改编题",
    self_written: "自编题",
    unknown: "来源待确认"
  };
  return labels[kind];
}

export function SearchResults({ results }: { results: RagSearchResult[] }) {
  return (
    <section className="rag-results explained-results" aria-label="检索结果">
      {results.map((result, index) => {
        const isQuestion = Boolean(result.question);
        const tags = result.matchedTags?.slice(0, 4) || [];
        return (
          <article key={result.chunk.id} className="result-item explained-result">
            <header>
              <span className="result-rank">{String(index + 1).padStart(2, "0")}</span>
              <span className="result-type-icon">{isQuestion ? <FileQuestion size={16} /> : <BookOpenText size={16} />}</span>
              <div>
                <strong>{result.question?.questionNumber ? `${result.question.questionNumber} · ` : ""}{result.material.title}</strong>
                <small>{result.material.path}</small>
              </div>
            </header>
            <div className="result-meta">
              {result.question ? (
                <>
                  <span>{sourceLabel(result.question.sourceKind)}</span>
                  {result.question.questionType ? <span>{result.question.questionType}</span> : null}
                  {result.question.difficulty ? <span>难度 {result.question.difficulty}</span> : null}
                  <span>{result.question.answerQuality === "detailed_solution" ? "详细解析" : result.question.hasAnswer ? "含答案" : "需验算"}</span>
                </>
              ) : (
                <span>{result.snippet?.kind === "answer" ? "答案解析" : "知识参考"}</span>
              )}
            </div>
            <p>{result.excerpt}</p>
            <footer>
              <span className="result-reason">{result.reason}</span>
              {tags.length ? <span className="matched-tags"><Tags size={12} />{tags.join(" · ")}</span> : null}
            </footer>
          </article>
        );
      })}
    </section>
  );
}
