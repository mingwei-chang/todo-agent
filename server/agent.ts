import type { ChatMessage } from "../shared/chat.ts";
import { getModelClient, model } from "./model.ts";

export type { ChatMessage } from "../shared/chat.ts";

const TASKS_API = `http://127.0.0.1:${process.env.PORT ?? 3000}/api/tasks`;

interface Task {
  id: string;
  title: string;
  done: boolean;
  due?: string;
}

async function callTasksApi(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${TASKS_API}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data && data.error ? data.error : `HTTP ${response.status}`);
  }
  return data;
}

async function listTasks(): Promise<Task[]> {
  return (await callTasksApi("GET", "")) as Task[];
}

function toModelMessages(messages: ChatMessage[]) {
  return messages.map((message) =>
    message.role === "user"
      ? { role: "user" as const, content: message.content }
      : { role: "assistant" as const, content: message.content },
  );
}

// 服务器本地日期，格式 YYYY-MM-DD。
// 不能用 toISOString：那是 UTC，东八区晚上八点之后会差一天。
function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00`);
  const end = Date.parse(`${to}T00:00:00`);
  return Math.round((end - start) / 86400000);
}

// 到期日的展示后缀。今天到期算"还能做"，过了今天才算逾期。
function dueLabel(task: Task): string {
  if (!task.due) return "";

  const now = today();
  if (task.done) return `（${task.due}）`;
  if (task.due > now) return `（${task.due} 到期）`;
  if (task.due === now) return "（今天到期）";
  return `（已逾期 ${daysBetween(task.due, now)} 天）`;
}

// 给模型看的清单：带汇总数字、到期日和 id，方便它指认要操作哪一条。
function formatListing(tasks: Task[]): string {
  if (tasks.length === 0) return "（当前没有任何任务）";

  const pending = tasks.filter((task) => !task.done).length;
  const lines = tasks
    .map(
      (task, index) =>
        `${index + 1}. ${task.done ? "✅" : "□"} ${task.title}${dueLabel(task)}（id: ${task.id}）`,
    )
    .join("\n");

  return `共 ${tasks.length} 条，待办 ${pending} 条，已完成 ${tasks.length - pending} 条：\n${lines}`;
}

// 给用户看的清单：由代码渲染，按状态分组、保留原始序号、不显示 id。
function formatForUser(tasks: Task[]): string {
  if (tasks.length === 0) return "你现在没有待办。";

  const numbered = tasks.map((task, index) => ({ no: index + 1, task }));
  const pending = numbered.filter((item) => !item.task.done);
  const finished = numbered.filter((item) => item.task.done);

  const parts = [`共 ${tasks.length} 条，待办 ${pending.length} 条，已完成 ${finished.length} 条。`];

  if (pending.length > 0) {
    parts.push("", "待办：");
    for (const item of pending) parts.push(`${item.no}. □ ${item.task.title}${dueLabel(item.task)}`);
  }

  if (finished.length > 0) {
    parts.push("", "已完成：");
    for (const item of finished) parts.push(`${item.no}. ✅ ${item.task.title}`);
  }

  return parts.join("\n");
}

// 今天到期 + 已逾期。已完成的、没有到期日的、以后的都不算。
function formatDueList(tasks: Task[]): string {
  const now = today();
  const numbered = tasks.map((task, index) => ({ no: index + 1, task }));
  const scheduled = numbered.filter((item) => !item.task.done && item.task.due);
  const dueToday = scheduled.filter((item) => item.task.due === now);
  const overdue = scheduled.filter((item) => (item.task.due as string) < now);

  if (dueToday.length === 0 && overdue.length === 0) {
    return "今天没有到期的任务，也没有逾期的。";
  }

  const parts: string[] = [];

  if (dueToday.length > 0) {
    parts.push("今天到期（今天还能做）：");
    for (const item of dueToday) parts.push(`${item.no}. □ ${item.task.title}`);
  }

  if (overdue.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push("已逾期：");
    for (const item of overdue) {
      const days = daysBetween(item.task.due as string, now);
      parts.push(`${item.no}. □ ${item.task.title}（逾期 ${days} 天）`);
    }
  }

  return parts.join("\n");
}

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "listTasks",
      description: "查看用户当前的待办清单。用户问'我有哪些任务''看看清单''还有什么没做'时调用。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "listDueTasks",
      description:
        "查看今天到期和已经逾期的未完成任务。用户问'今天有什么到期''有没有过期的''最近要交什么'时调用。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "addTask",
      description: "新增一条待办任务。用户说'记一下''提醒我''别忘了'时使用。",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "任务标题，只保留任务本身，比如'买牛奶'，不要带'帮我记一下'。",
          },
          due: {
            type: "string",
            description:
              "到期日，格式 YYYY-MM-DD。用户说了截止时间才填，没提就不要填这个字段。",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "completeTask",
      description: "把一条已有任务标记为已完成。用户说'做完了''搞定了''买好了'时使用。",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "目标任务的 id，必须从当前清单里原样复制，不要自己编。",
          },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "deleteTask",
      description: "删除一条任务。用户说'删掉''去掉''不用了'时使用。",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "目标任务的 id，必须从当前清单里原样复制，不要自己编。",
          },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "renameTask",
      description:
        "修改一条已有任务的标题，任务本身保留不变。用户说'把XX改成YY''XX 改成 YY'时使用。不要用先删除再新建的方式模拟改名。",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "目标任务的 id，必须从当前清单里原样复制，不要自己编。",
          },
          title: {
            type: "string",
            description: "新的任务标题，只保留任务本身的内容，不要带'改成'这类字眼。",
          },
        },
        required: ["taskId", "title"],
        additionalProperties: false,
      },
    },
  },
];

function buildSystemPrompt(todayDate: string): string {
  return `你是"小明"，一个中文待办清单助手。
今天的日期是 ${todayDate}。每次对话我都会告诉你用户当前的清单（含汇总数字、每条的序号和到期日），你要据此回答。

规则：
- 用户想查看清单时，必须调用 listTasks 工具，不要在回复里自己列出任务。
- 用户问到"有哪些到期""有没有逾期"时，必须调用 listDueTasks 工具。
- 用户提到"明天""后天""下周三"这类时间时，你按今天的日期换算成 YYYY-MM-DD 填进 due；用户没提到期时间就不要填。
- 只根据清单回答，绝不编造清单里没有的任务。
- 创建、完成、删除、修改标题时必须调用对应的工具，不要只在嘴上答应。
- 用简短的中文口语回答，不要输出 JSON 或 Markdown 表格。`;
}

async function executeToolCall(call: {
  id: string;
  function: { name: string; arguments: string };
}): Promise<string> {
  let args: Record<string, string>;
  try {
    args = JSON.parse(call.function.arguments) as Record<string, string>;
  } catch {
    return "参数解析失败：工具参数不是合法 JSON。";
  }

  try {
    switch (call.function.name) {
      case "listTasks": {
        return formatForUser(await listTasks());
      }
      case "listDueTasks": {
        return formatDueList(await listTasks());
      }
      case "addTask": {
        const body: { title: string; due?: string } = { title: args.title };
        if (args.due) body.due = args.due;
        const task = await callTasksApi("POST", "", body);
        return `已创建任务「${task.title}」${task.due ? `，到期日 ${task.due}` : ""}，当前未完成，id=${task.id}`;
      }
      case "completeTask": {
        const task = await callTasksApi("PATCH", `/${args.taskId}`, { done: true });
        return `任务「${task.title}」已标记为已完成。`;
      }
      case "deleteTask": {
        await callTasksApi("DELETE", `/${args.taskId}`);
        return "任务已删除。";
      }
      case "renameTask": {
        const task = await callTasksApi("PATCH", `/${args.taskId}`, { title: args.title });
        return `任务已改名为「${task.title}」。`;
      }
      default:
        return `没有这个工具：${call.function.name}`;
    }
  } catch (error) {
    return `执行失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

// 最多允许模型连续调用工具的轮数。
const MAX_ROUNDS = 4;

export async function reply(messages: ChatMessage[]): Promise<string> {
  const history = toModelMessages(messages);
  const client = getModelClient();
  const systemPrompt = buildSystemPrompt(today());

  const conversation: any[] = [
    {
      role: "system" as const,
      content: `${systemPrompt}\n\n当前清单：\n${formatListing(await listTasks())}`,
    },
    ...history,
  ];

  let lastResults: string[] = [];

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const completion = await client.chat.completions.create({
      model,
      messages: conversation,
      tools: TOOLS,
      tool_choice: "auto",
    });

    const message = completion.choices[0]?.message;

    if (!message?.tool_calls?.length) {
      return message?.content?.trim() || "抱歉，我没听明白。";
    }

    console.log(
      "工具调用：",
      message.tool_calls.map((c) => `${c.function.name}(${c.function.arguments})`).join(" | "),
    );

    const executed: { name: string; callId: string; content: string }[] = [];
    for (const call of message.tool_calls) {
      executed.push({
        name: call.function.name,
        callId: call.id,
        content: await executeToolCall(call),
      });
    }
    lastResults = executed.map((item) => item.content);

    // 第一轮只是查询（看清单或看到期）：直接用代码渲染的文本回复，不交给模型复述。
    const isQuery = executed.every(
      (item) => item.name === "listTasks" || item.name === "listDueTasks",
    );
    if (round === 1 && isQuery) {
      return executed[executed.length - 1].content;
    }

    conversation.push(message);
    for (const item of executed) {
      conversation.push({ role: "tool" as const, tool_call_id: item.callId, content: item.content });
    }
  }

  return lastResults.join("\n\n") || "抱歉，这一步我没能完成。";
}
