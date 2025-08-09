import { z } from 'zod';
import { Tool as SDKTool } from '@modelcontextprotocol/sdk/types.js';
import { ImageContent } from '../transports/utils/image-handler.js';

// Type to check if a Zod type has a description
type HasDescription<T> = T extends { _def: { description: string } } ? T : never;

// Type to ensure all properties in a Zod object have descriptions
type AllFieldsHaveDescriptions<T extends z.ZodRawShape> = {
  [K in keyof T]: HasDescription<T[K]>;
};

export type ToolInputSchema<T> = {
  [K in keyof T]: {
    type: z.ZodType<T[K]>;
    description: string;
  };
};

export type ToolInput<T extends ToolInputSchema<any>> = {
  [K in keyof T]: z.infer<T[K]['type']>;
};

// Type helper to infer input type from schema
export type InferSchemaType<TSchema> =
  TSchema extends z.ZodObject<any> ? z.infer<TSchema> : TSchema extends ToolInputSchema<infer T> ? T : never;

// Magic type that infers from the schema property of the current class
export type MCPInput<T extends MCPTool<any, any> = MCPTool<any, any>> = InferSchemaType<T['schema']>;

export type TextContent = {
  type: 'text';
  text: string;
};

export type ErrorContent = {
  type: 'error';
  text: string;
};

export type ToolContent = TextContent | ErrorContent | ImageContent;

export type ToolResponse = {
  content: ToolContent[];
};

export interface ToolProtocol extends SDKTool {
  name: string;
  description: string;
  toolDefinition: {
    name: string;
    description: string;
    inputSchema: {
      type: 'object';
      properties?: Record<string, unknown>;
      required?: string[];
    };
  };
  toolCall(request: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<ToolResponse>;
}

/**
 * Base class for MCP tools using Zod schemas for input validation and type inference.
 *
 * Define your tool schema using Zod with descriptions:
 * ```typescript
 * const schema = z.object({
 *   message: z.string().describe("The message to process")
 * });
 *
 * class MyTool extends MCPTool {
 *   name = "my_tool";
 *   description = "My tool description";
 *   schema = schema;
 *
 *   async execute(input: McpInput<this>) {
 *     // input is fully typed from your schema
 *     return input.message;
 *   }
 * }
 * ```
 */
export abstract class MCPTool<TInput extends Record<string, any> = any, TSchema = any> implements ToolProtocol {
  abstract name: string;
  abstract description: string;
  protected abstract schema: TSchema extends z.ZodObject<any>
    ? TSchema
    : TSchema extends ToolInputSchema<any>
      ? TSchema
      : z.ZodObject<any> | ToolInputSchema<TInput>;
  protected useStringify: boolean = true;
  [key: string]: unknown;

  /**
   * Validates the tool schema. This is called automatically when the tool is registered
   * with an MCP server, but can also be called manually for testing.
   */
  public validate(): void {
    if (this.isZodObjectSchema(this.schema)) {
      // Access inputSchema to trigger validation
    }
  }

  private isZodObjectSchema(schema: unknown): schema is z.ZodObject<any> {
    return schema instanceof z.ZodObject;
  }

  get inputSchema(): { type: 'object'; properties?: Record<string, unknown>; required?: string[] } {
    if (!this.isZodObjectSchema(this.schema)) {
      throw new Error(`Invalid schema type: ${typeof this.schema}`);
    }
    return this.generateSchemaFromZodObject(this.schema);
  }

  private generateSchemaFromZodObject(zodSchema: z.ZodObject<any>): {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  } {
    const shape = zodSchema.shape;
    const properties: Record<string, any> = {};
    const required: string[] = [];
    const missingDescriptions: string[] = [];

    Object.entries(shape).forEach(([key, fieldSchema]) => {
      const fieldInfo = this.extractFieldInfo(fieldSchema as z.ZodType);

      if (!fieldInfo.jsonSchema.description) {
        missingDescriptions.push(key);
      }

      properties[key] = fieldInfo.jsonSchema;

      if (!fieldInfo.isOptional) {
        required.push(key);
      }
    });

    if (missingDescriptions.length > 0) {
      throw new Error(
        `Missing descriptions for fields in ${this.name}: ${missingDescriptions.join(', ')}. ` +
          `All fields must have descriptions when using Zod object schemas. ` +
          `Use .describe() on each field, e.g., z.string().describe("Field description")`
      );
    }

    return {
      type: 'object',
      properties,
      required,
    };
  }

  private extractFieldInfo(schema: z.ZodType): {
    jsonSchema: any;
    isOptional: boolean;
  } {
    return { jsonSchema: z.toJSONSchema(schema), isOptional: schema instanceof z.ZodOptional };
  }

  get toolDefinition() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
    };
  }

  protected abstract execute(input: TSchema extends z.ZodObject<any> ? z.infer<TSchema> : TInput): Promise<unknown>;

  async toolCall(request: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<ToolResponse> {
    try {
      const args = request.params.arguments || {};
      const validatedInput = await this.validateInput(args);
      const result = await this.execute(validatedInput as TSchema extends z.ZodObject<any> ? z.infer<TSchema> : TInput);
      return this.createSuccessResponse(result);
    } catch (error) {
      return this.createErrorResponse(error as Error);
    }
  }

  private async validateInput(args: Record<string, unknown>): Promise<TInput> {
    if (this.isZodObjectSchema(this.schema)) {
      return this.schema.parse(args) as TInput;
    } else {
      const zodSchema = z.object(
        Object.fromEntries(
          Object.entries(this.schema as ToolInputSchema<TInput>).map(([key, schema]) => [key, schema.type])
        )
      );
      return zodSchema.parse(args) as TInput;
    }
  }

  protected createSuccessResponse(data: unknown): ToolResponse {
    if (this.isImageContent(data)) {
      return {
        content: [data],
      };
    }

    if (Array.isArray(data)) {
      const validContent = data.filter((item) => this.isValidContent(item)) as ToolContent[];
      if (validContent.length > 0) {
        return {
          content: validContent,
        };
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: this.useStringify ? JSON.stringify(data) : String(data),
        },
      ],
    };
  }

  protected createErrorResponse(error: Error): ToolResponse {
    return {
      content: [{ type: 'error', text: error.message }],
    };
  }

  private isImageContent(data: unknown): data is ImageContent {
    return (
      typeof data === 'object' &&
      data !== null &&
      'type' in data &&
      data.type === 'image' &&
      'data' in data &&
      'mimeType' in data &&
      typeof (data as ImageContent).data === 'string' &&
      typeof (data as ImageContent).mimeType === 'string'
    );
  }

  private isTextContent(data: unknown): data is TextContent {
    return (
      typeof data === 'object' &&
      data !== null &&
      'type' in data &&
      data.type === 'text' &&
      'text' in data &&
      typeof (data as TextContent).text === 'string'
    );
  }

  private isErrorContent(data: unknown): data is ErrorContent {
    return (
      typeof data === 'object' &&
      data !== null &&
      'type' in data &&
      data.type === 'error' &&
      'text' in data &&
      typeof (data as ErrorContent).text === 'string'
    );
  }

  private isValidContent(data: unknown): data is ToolContent {
    return this.isImageContent(data) || this.isTextContent(data) || this.isErrorContent(data);
  }

  protected async fetch<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
  }
}

/**
 * Helper function to define tool schemas with required descriptions.
 * This ensures all fields have descriptions at build time.
 *
 * @example
 * const schema = defineSchema({
 *   name: z.string().describe("User's name"),
 *   age: z.number().describe("User's age")
 * });
 */
export function defineSchema<T extends z.ZodRawShape>(shape: T): z.ZodObject<T> {
  // Check descriptions at runtime during development
  if (process.env.NODE_ENV !== 'production') {
    for (const [key, value] of Object.entries(shape)) {
      let schema = value;
      let hasDescription = false;

      // Check the schema and its wrapped versions for description
      while (schema && typeof schema === 'object') {
        // @ts-expect-error -- bad types
        if ('_def' in schema && schema._def?.description) {
          hasDescription = true;
          break;
        }
        // Check wrapped types
        if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema instanceof z.ZodNullable) {
          schema = schema._def.innerType || (schema as any).unwrap();
        } else {
          break;
        }
      }

      if (!hasDescription) {
        throw new Error(
          `Field '${key}' is missing a description. Use .describe() to add one.\n` +
            `Example: ${key}: z.string().describe("Description for ${key}")`
        );
      }
    }
  }

  return z.object(shape);
}
