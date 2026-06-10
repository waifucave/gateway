import { z } from "zod";

const ParamDescriptorSchema = z
  .object({
    type: z.enum(["number", "int", "boolean", "enum", "string", "string[]", "map"]),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    values: z.array(z.string()).optional(),
    maxItems: z.number().int().optional(),
    default: z.unknown().optional(),
    wireName: z.string().optional(),
    confidence: z.enum(["verified", "unverified"]).optional()
  })
  .strict();

const ConstraintConditionSchema: z.ZodType<unknown> = z.lazy(() =>
  z
    .object({
      param: z.string().optional(),
      eq: z.unknown().optional(),
      neq: z.unknown().optional(),
      gt: z.number().optional(),
      lt: z.number().optional(),
      in: z.array(z.unknown()).optional(),
      allOf: z.array(ConstraintConditionSchema).optional(),
      anyOf: z.array(ConstraintConditionSchema).optional()
    })
    .strict()
);

const ConstraintRuleSchema = z
  .object({
    id: z.string().min(1),
    when: ConstraintConditionSchema,
    then: z
      .object({
        forbid: z.array(z.string()).optional(),
        drop: z.array(z.string()).optional(),
        force: z.record(z.string(), z.unknown()).optional(),
        clamp: z.record(z.string(), z.object({ min: z.number().optional(), max: z.number().optional() }).strict()).optional()
      })
      .strict(),
    source: z.string().optional()
  })
  .strict();

const PricingSchema = z
  .object({
    inputPerMTok: z.number().nullable().optional(),
    outputPerMTok: z.number().nullable().optional(),
    cachedInputPerMTok: z.number().nullable().optional()
  })
  .strict();

const RouteOverridesSchema = z
  .object({
    baseUrl: z.string().url().optional(),
    endpoint: z.string().optional(),
    contextTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().nullable().optional(),
    pricing: PricingSchema.optional(),
    modalities: z.array(z.string()).optional(),
    supportedParameters: z.array(z.string()).optional(),
    status: z.string().optional(),
    source: z.string().optional(),
    note: z.string().optional(),
    mode: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    alternateChinaBaseUrl: z.string().url().optional(),
    anthropicEndpoint: z.string().url().optional()
  })
  .strict();

export const CapabilityDocSchema = z
  .object({
    schema: z.literal("starlight.capability-doc.v1"),
    family: z.string().min(1),
    displayName: z.string().min(1),
    company: z.string().min(1),
    routes: z
      .array(
        z
          .object({
            providerId: z.string().min(1),
            modelId: z.string().min(1),
            wire: z.enum(["openai-chat", "openai-responses", "anthropic-messages", "google-generative-language"]),
            overrides: RouteOverridesSchema.optional()
          })
          .strict()
      )
      .min(1),
    limits: z.object({ contextTokens: z.number().int(), maxOutputTokens: z.number().int() }).strict(),
    modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }).strict(),
    features: z
      .object({
        streaming: z.boolean(),
        streamingUsage: z.boolean().optional(),
        tools: z
          .object({
            supported: z.boolean(),
            toolChoice: z.array(z.enum(["auto", "none", "required", "named"])).optional(),
            parallel: z.boolean().optional(),
            parallelDisable: z.boolean().optional(),
            strict: z.boolean().optional()
          })
          .strict(),
        structuredOutput: z
          .object({ jsonMode: z.boolean().optional(), jsonSchema: z.boolean().optional(), strict: z.boolean().optional() })
          .strict(),
        promptCaching: z.object({ kind: z.enum(["none", "implicit", "explicit"]) }).strict(),
        assistantPrefill: z.boolean().optional(),
        systemRole: z.enum(["system", "developer", "top-level", "systemInstruction"]),
        multipleSystemMessages: z.boolean().optional(),
        reasoningRoundTrip: z.boolean().optional()
      })
      .strict(),
    params: z.record(z.string(), ParamDescriptorSchema),
    constraints: z.array(ConstraintRuleSchema).optional(),
    meta: z
      .object({
        pricing: PricingSchema.optional(),
        knowledgeCutoff: z.string().optional(),
        deprecated: z.boolean().optional(),
        availability: z.string().optional(),
        sources: z.array(z.string()).min(1),
        verifiedAt: z.string().optional(),
        confidence: z.enum(["verified", "partial", "unverified", "conflicting"])
      })
      .strict()
  })
  .strict();

export type CapabilityDocParsed = z.infer<typeof CapabilityDocSchema>;
