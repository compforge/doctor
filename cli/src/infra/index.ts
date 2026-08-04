import { doctorHostInfra, type DoctorHostInfra } from "./host";
import {
  hostTargetFileTransfer,
  type HostTargetFileTransfer,
} from "./file-transfer";
import { imageRegistry, type ImageRegistry } from "./image";
import { doctorTargetInfra, type DoctorTargetInfra } from "./target";

/** The infrastructure capabilities required by CLI application flows. */
export interface DoctorInfra {
  fileTransfer: HostTargetFileTransfer;
  host: DoctorHostInfra;
  image: ImageRegistry;
  target: DoctorTargetInfra;
}

export const infra: DoctorInfra = {
  fileTransfer: hostTargetFileTransfer,
  host: doctorHostInfra,
  image: imageRegistry,
  target: doctorTargetInfra,
};
