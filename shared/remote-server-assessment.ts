import assessment from "./remote-server-assessment.cjs";

export type {
  RemoteBoundaryEvidence,
  RemoteCoreRequirement,
  RemoteFeatureAssessment,
  RemoteFeatureContracts,
  RemoteFeatureRequirement,
  RemoteServerAssessment,
  RemoteServerAssessmentInput,
} from "./remote-server-assessment.cjs";

export const {
  REMOTE_INPUT_DRAFT_FEATURE_REQUIREMENTS,
  applyRemoteFeatureObservation,
  assessRemoteServer,
  compareCanonicalRuntimeVersions,
  parseCanonicalRuntimeVersion,
} = assessment;
