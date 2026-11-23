"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { ContainerLogs } from "../../../../../../../components/container-logs";
import { DockerView } from "../../../../../../../components/gate";
import { PageFrame } from "../../../../../../../components/shell";

export default function ContainerLogsPage() {
  const params = useParams<{ id: string; containerId: string }>();
  const [name, setName] = useState("");
  const [reload, setReload] = useState(0);
  const list = `/e/${params.id}/containers`;
  const detail = `/e/${params.id}/containers/${encodeURIComponent(params.containerId)}`;
  const crumbs = name
    ? [{ label: "Containers", href: list }, { label: name, href: detail, mono: true }, { label: "Logs" }]
    : [{ label: "Containers", href: list }, { label: "Logs" }];
  return (
    <PageFrame title="Container logs" crumbs={crumbs} onRefresh={() => setReload((value) => value + 1)}>
      <DockerView noun="logs">
        {(endpoint) => (
          <ContainerLogs
            endpointId={endpoint.id}
            containerId={decodeURIComponent(params.containerId)}
            reload={reload}
            onName={setName}
          />
        )}
      </DockerView>
    </PageFrame>
  );
}