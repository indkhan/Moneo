const bodyThatIsNotJsonFailsValidation = () => null;

export const jsonBodyOrNull = (source: { json(): Promise<unknown> }): Promise<unknown> => source.json().catch(bodyThatIsNotJsonFailsValidation);
