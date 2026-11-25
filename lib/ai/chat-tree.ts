export type ChatNode = { id: string; parent: string | null; regenerates: string | null; created_at: string };
export type PathStep = { after: string | null; question: string; answer: string; questions: string[]; answers: string[] };
export type ChatPicks = Record<string, string>;

export const questionPick = (step: Pick<PathStep, "after" | "questions">) => `after:${step.after ?? "start"}:${step.questions.length}`;
export const answerPick = (step: Pick<PathStep, "question" | "answers">) => `of:${step.question}:${step.answers.length}`;

export function ancestors(nodes: ChatNode[], leaf: string | null): ChatNode[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const path: ChatNode[] = [];
  for (let node = leaf ? byId.get(leaf) : undefined; node; node = node.parent ? byId.get(node.parent) : undefined) path.push(node);
  return path.reverse();
}

export function visiblePath(nodes: ChatNode[], picks: ChatPicks = {}): PathStep[] {
  const sorted = [...nodes].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const known = new Set(sorted.map(node => node.id));
  const children = new Map<string, ChatNode[]>();
  for (const node of sorted) {
    const key = node.parent && known.has(node.parent) ? node.parent : "";
    children.set(key, [...children.get(key) ?? [], node]);
  }
  const newest = new Map<string, string>();
  const latest = (node: ChatNode): string => {
    const value = newest.get(node.id) ?? (children.get(node.id) ?? []).map(latest).reduce((max, time) => time > max ? time : max, node.created_at);
    newest.set(node.id, value);
    return value;
  };
  const newestOf = (options: ChatNode[], score: (node: ChatNode) => string) => options.reduce((best, node) => score(node) >= score(best) ? node : best);
  const steps: PathStep[] = [];
  for (let after: string | null = null; ;) {
    const here = children.get(after ?? "") ?? [];
    const questions = here.filter(node => !node.regenerates || !here.some(other => other.id === node.regenerates));
    if (!questions.length) return steps;
    const versionsOf = (question: ChatNode) => here.filter(node => node.id === question.id || node.regenerates === question.id);
    const ids = questions.map(node => node.id);
    const question = questions.find(node => node.id === picks[questionPick({ after, questions: ids })])
      ?? newestOf(questions, node => versionsOf(node).map(latest).reduce((max, time) => time > max ? time : max));
    const versions = versionsOf(question);
    const answers = versions.map(node => node.id);
    const answer = versions.find(node => node.id === picks[answerPick({ question: question.id, answers })]) ?? newestOf(versions, latest);
    steps.push({ after, question: question.id, answer: answer.id, questions: ids, answers });
    after = answer.id;
  }
}
