import { discoverLocalContainerEngine } from "./container-engine";
import {
  networkAnalysisInfra,
  type NetworkAnalysisInfra,
} from "./network-analysis";

/** Capabilities executed on the machine running the Doctor CLI. */
export interface DoctorHostInfra {
  containerEngine: typeof discoverLocalContainerEngine;
  networkAnalysis: NetworkAnalysisInfra;
}

export const doctorHostInfra: DoctorHostInfra = {
  containerEngine: discoverLocalContainerEngine,
  networkAnalysis: networkAnalysisInfra,
};

