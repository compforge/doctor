import { discoverLocalContainerEngine } from "./container-engine";
import { resolveHostExecution } from "./execution";
import {
  networkAnalysisInfra,
  type NetworkAnalysisInfra,
} from "./network-analysis";

/** Capabilities executed on the machine running the Doctor CLI. */
export interface DoctorHostInfra {
  containerEngine: typeof discoverLocalContainerEngine;
  resolveExecution: typeof resolveHostExecution;
  networkAnalysis: NetworkAnalysisInfra;
}

export const doctorHostInfra: DoctorHostInfra = {
  containerEngine: discoverLocalContainerEngine,
  resolveExecution: resolveHostExecution,
  networkAnalysis: networkAnalysisInfra,
};

export * from "./execution";
export * from "./info";
