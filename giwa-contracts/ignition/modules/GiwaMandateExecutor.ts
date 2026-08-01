import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("GiwaMandateExecutorModule", (m) => {
  const executor = m.contract("GiwaMandateExecutor");
  return { executor };
});
