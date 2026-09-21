import { startDoctor } from "doctor-cli/embed";
import { testPlugin } from "./test-plugin";

startDoctor({ plugin: testPlugin });
