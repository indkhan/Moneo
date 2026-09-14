export function evaluateFinancialAnswer(input: {
  answer: string;
  expectedAmountMinor: string;
  evidenceRef: string | null;
  expectedEvidenceRef: string;
  tool: string;
  expectedTool: string;
}) {
  const expected = (Number(input.expectedAmountMinor) / 100).toFixed(2);
  const numericCorrect = input.answer.includes(expected);
  const toolSelected = input.tool === input.expectedTool;
  const evidenceCorrect = input.evidenceRef === input.expectedEvidenceRef;
  return {
    numericCorrect,
    toolSelected,
    evidenceCorrect,
    unsupportedClaim: !numericCorrect || !evidenceCorrect,
  };
}
