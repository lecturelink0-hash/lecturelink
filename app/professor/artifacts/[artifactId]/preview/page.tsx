import { BridgeArtifactViewer } from "@/components/professor/BridgeArtifactViewer";

export default async function Page({
  params,
}: {
  params: Promise<{ artifactId: string }>;
}) {
  return <BridgeArtifactViewer artifactId={(await params).artifactId} />;
}
