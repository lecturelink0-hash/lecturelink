import { Loader2 } from "lucide-react";
import "./professor-task-progress.css";

type ProfessorTaskProgressProps = {
  description: string;
};

export function ProfessorTaskProgress({
  description,
}: ProfessorTaskProgressProps) {
  return (
    <section
      className="professor-task-progress"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="professor-task-progress-icon" aria-hidden="true">
        <Loader2 />
      </span>
      <div>
        <h2>작업 중입니다...</h2>
        <p>{description}</p>
      </div>
      <span className="professor-task-progress-line" aria-hidden="true" />
    </section>
  );
}
