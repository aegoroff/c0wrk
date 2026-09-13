import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { listProviderModels } from '@/api/mcp'
import { isOpenAICompatibleProvider } from '@/lib/llm-providers'
import type { ProviderConfig } from './useLLMConfig'

interface UseModelFetchResult {
    models: string[]
    modelsLoading: boolean
    modelsError: string | null
    apiKeyDirty: boolean
    handleApply: () => Promise<void>
    hasRequiredCredentials: boolean
}

export function useModelFetch(activeProvider: string, providerConfigs: Record<string, ProviderConfig>): UseModelFetchResult {
    const [models, setModels] = useState<string[]>([])
    const [modelsLoading, setModelsLoading] = useState(false)
    const [modelsError, setModelsError] = useState<string | null>(null)
    const [apiKeyDirty, setApiKeyDirty] = useState(true)
    const fetchIdRef = useRef(0)

    const credentialKey = (!activeProvider || !providerConfigs[activeProvider])
        ? ''
        : `${activeProvider}|${providerConfigs[activeProvider].api_key}|${providerConfigs[activeProvider].base_url}`

    useEffect(() => {
        fetchIdRef.current += 1
        setModels([])
        setModelsError(null)
        setApiKeyDirty(true)
    }, [credentialKey])

    const hasRequiredCredentials = useMemo(() => {
        if (!activeProvider || !providerConfigs[activeProvider]) return false
        const config = providerConfigs[activeProvider]
        const needsBaseUrl = isOpenAICompatibleProvider(activeProvider)
        const needsApiKey = true
        if (needsBaseUrl && !config.base_url) return false
        if (needsApiKey && !config.api_key) return false
        return true
    }, [activeProvider, providerConfigs])

    const handleApply = useCallback(async () => {
        if (!activeProvider) return
        const config = providerConfigs[activeProvider]
        if (!config) return
        const myId = ++fetchIdRef.current
        setModelsLoading(true)
        setModelsError(null)
        try {
            // Pass draft credentials so an unsaved compatible provider
            // (first-run / no default_model yet) can still list models —
            // ListProviderModels only sees persisted config otherwise.
            const list = await listProviderModels({
                provider: activeProvider,
                api_key: config.api_key,
                base_url: config.base_url || undefined,
                type: config.type,
            })
            if (myId !== fetchIdRef.current) return
            setModels(list || [])
            setApiKeyDirty(false)
        } catch (err) {
            if (myId !== fetchIdRef.current) return
            setModelsError(err instanceof Error ? err.message : String(err))
            setModels([])
        } finally {
            if (myId === fetchIdRef.current) setModelsLoading(false)
        }
    }, [activeProvider, providerConfigs])

    return {
        models,
        modelsLoading,
        modelsError,
        apiKeyDirty,
        handleApply,
        hasRequiredCredentials,
    }
}
