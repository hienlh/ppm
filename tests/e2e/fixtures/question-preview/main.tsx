import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist/wght.css";
import "@fontsource/monaspace-argon/latin-400.css";
import "./fixture.css";
import { QuestionCard } from "../../../../src/web/components/chat/question-card";
import { ToolCard } from "../../../../src/web/components/chat/tool-cards";

/** The shape Claude sent in the reported chat: the plan lives only in the options' `preview`. */
const PLAN = `KẾ HOẠCH — dựng UK server

1. Tạo VM Ubuntu 24.04, 4 vCPU / 16 GB RAM
2. Cài PostgreSQL 16, bật replication từ máy chính
3. Đợi replication bắt kịp (theo dõi replay_lag)
4. Chép cấu hình app + secrets từ vault
5. Chạy smoke test: đăng nhập, tạo payroll nháp
6. Chuyển DNS uk.nxsys.tech sang máy mới

Dừng và báo anh nếu:
  - replication không bắt kịp sau 30 phút
  - VM thiếu RAM khi chạy smoke test`;

// `?long`: a plan many screens tall, to check the pane caps its height and scrolls inside.
const longPlan = location.search.includes("long")
  ? Array.from({ length: 8 }, (_, i) => PLAN.replace("KẾ HOẠCH", `PHẦN ${i + 1}`)).join("\n\n")
  : null;

const questions = [{
  header: "Kế hoạch",
  question: "Đây là kế hoạch, anh xem trong khung bên cạnh lựa chọn. Đúng ý chưa, em bắt đầu nhé?",
  options: [
    { label: "Đúng, làm luôn (Recommended)", description: "Em làm từ bước 1 đến 6.", preview: longPlan ?? PLAN },
    { label: "Cần sửa", description: "Anh ghi lại chỗ muốn đổi.", preview: "Ghi chỗ muốn đổi vào ô Other bên dưới,\nem sửa kế hoạch rồi hỏi lại." },
  ],
}];

const answered = { questions, answers: { [questions[0]!.question]: "Đúng, làm luôn (Recommended)" } };

(window as any).__submitted = null;
createRoot(document.getElementById("root")!).render(
  <div className="mx-auto max-w-4xl space-y-4">
    <ToolCard tool={{ type: "tool_use", tool: "AskUserQuestion", input: answered, toolUseId: "t1" } as any} />
    <QuestionCard questions={questions} autoFocus={false}
      onSubmit={(answers) => { (window as any).__submitted = answers; }} onSkip={() => {}} />
  </div>,
);
