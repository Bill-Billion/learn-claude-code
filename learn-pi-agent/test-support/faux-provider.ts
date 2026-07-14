import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";

export function setupFauxProvider(responses: FauxResponseStep[]): FauxProviderRegistration {
  const registration = registerFauxProvider({
    tokensPerSecond: 0,
    tokenSize: { min: 100, max: 100 },
  });
  registration.setResponses(responses);
  return registration;
}

export {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
};
