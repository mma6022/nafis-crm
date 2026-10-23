import { defineConfig, InputTransformerFn } from "orval";
import path from "path";

const root = path.resolve(__dirname, "..", "..");
const apiClientReactSrc = path.resolve(root, "lib", "api-client-react", "src");
const apiZodSrc = path.resolve(root, "lib", "api-zod", "src");

// Our exports make assumptions about the title of the API being "Api" (i.e. generated output is `api.ts`).
const titleTransformer: InputTransformerFn = (config) => {
  config.info ??= {};
  config.info.title = "Api";

  return config;
};

export default defineConfig({
  "api-client-react": {
    input: {
      target: "./openapi.yaml",
      parserOptions: { externalRefs: { allow: ["./loan-case-notes.yaml", "./site-notifications.yaml", "./sales-reports.yaml", "./internal-chat.yaml", "./diagnostics.yaml", "./social-monitor.yaml", "./registration-suggestions.yaml"] } },
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiClientReactSrc,
      target: "generated",
      client: "react-query",
      mode: "split",
      baseUrl: "/api",
      clean: true,
      prettier: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          path: path.resolve(apiClientReactSrc, "custom-fetch.ts"),
          name: "customFetch",
        },
      },
    },
  },
  zod: {
    input: {
      target: "./openapi.yaml",
      parserOptions: { externalRefs: { allow: ["./loan-case-notes.yaml", "./site-notifications.yaml", "./sales-reports.yaml", "./internal-chat.yaml", "./diagnostics.yaml", "./social-monitor.yaml", "./registration-suggestions.yaml"] } },
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiZodSrc,
      client: "zod",
      target: "generated",
      schemas: { path: "generated/types", type: "typescript" },
      mode: "split",
      clean: true,
      prettier: true,
      override: {
        zod: {
          // Orval resolves `auto` from lib/api-spec/package.json, which has no
          // zod dependency, so orval >= 8.23 falls back to Zod 4 syntax while
          // the catalog installs zod 3. Pin to match the catalog.
          version: 3,
          coerce: {
            query: ['boolean', 'number', 'string'],
            param: ['boolean', 'number', 'string'],
            body: ['bigint', 'date'],
            response: ['bigint', 'date'],
          },
        },
        operations: {
          getSocialMonitorThreadMessages: { zod: { generate: { param: false } } },
          listInternalChatMessages: { zod: { generate: { param: false } } },
          // Path validation is performed explicitly by the route. Otherwise
          // Orval gives path Zod and query TS exports the same Params name.
          downloadVoipRecording: { zod: { generate: { param: false } } },
          getVoipRecordingTranscript: { zod: { generate: { param: false } } },
          listStaffHumanMessages: { zod: { generate: { param: false } } },
          listCustomerEligiblePlans: { zod: { generate: { param: false } } },
          listLoanCaseNotes: { zod: { generate: { param: false } } },
          listLoanCaseHistory: { zod: { generate: { param: false } } },
        },
        useDates: true,
        useBigInt: true,
      },
    },
  },
});
