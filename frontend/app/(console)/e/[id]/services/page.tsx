"use client";

import { KubernetesGap } from "../../../../../components/k8s-gap";

export default function ServicesPage() {
  return <KubernetesGap title="Services" crumbs={[{ label: "Networking" }, { label: "Services" }]} />;
}
