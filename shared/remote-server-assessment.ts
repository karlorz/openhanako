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
  applyRemoteFeatureObservation,
  assessRemoteServer,
  compareCanonicalRuntimeVersions,
  parseCanonicalRuntimeVersion,
} = assessment;
