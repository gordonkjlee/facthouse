/**
 * One definition of the inference tool descriptions.
 * Registered only when config.inferences.enabled is true.
 */

export const CAPTURE_INFERENCE_DESCRIPTION =
  "Submit a hypothesis that nobody said, citing existing graduated fact ids as evidence. " +
  "Call this when you have inferred something from knowledge already in the store — not when the user just stated it (that is capture_fact), " +
  "and not during consolidate, which never invents. The hypothesis stays pending until validate_inference; it is not knowledge yet.";

export const VALIDATE_INFERENCE_DESCRIPTION =
  "Confirm or reject a pending hypothesis. Call this when the user has judged the inference, rather than confirming on your own. " +
  "Confirming graduates it as a fact labelled source_type inference with the supporting fact ids as provenance. " +
  "Rejecting records that it is not knowledge. Only a pending inference can be validated.";

export const LIST_INFERENCES_DESCRIPTION =
  "List hypotheses by status. Call this when you need to see pending inferences before asking the user to confirm, " +
  "rather than guessing they exist. Default status is pending. Confirmed rows are already in search_knowledge as labelled facts; " +
  "this list is the gate, not a second knowledge store.";
