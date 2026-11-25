import { z } from "zod";

export const modelIdSchema = z.string().trim().min(1).max(200);
