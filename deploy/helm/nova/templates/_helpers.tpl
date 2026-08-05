{{/* Chart name */}}
{{- define "nova.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully qualified app name */}}
{{- define "nova.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* Common labels */}}
{{- define "nova.labels" -}}
app.kubernetes.io/name: {{ include "nova.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Selector labels */}}
{{- define "nova.selectorLabels" -}}
app.kubernetes.io/name: {{ include "nova.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* The Secret name Nova reads its env from (existing or chart-created). */}}
{{- define "nova.secretName" -}}
{{- if .Values.secret.existingSecret -}}
{{- .Values.secret.existingSecret -}}
{{- else -}}
{{- include "nova.fullname" . -}}
{{- end -}}
{{- end -}}

{{/*
ConfigMap name for nova.config.yaml, suffixed with a short content hash.
The config is mounted via `subPath`, and Kubernetes does NOT propagate
ConfigMap updates to subPath mounts (kubelet even serves the cached copy to
new pods on the same node). Hashing the name means every config change yields
a brand-new ConfigMap object that no kubelet has cached, so pods always mount
fresh content. Helm garbage-collects the old (now-unreferenced) ConfigMap.
*/}}
{{- define "nova.configMapName" -}}
{{- printf "%s-config-%s" (include "nova.fullname" .) (toYaml .Values.novaConfig | sha256sum | trunc 8) -}}
{{- end -}}
