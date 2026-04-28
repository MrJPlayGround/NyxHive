import {
  CheckmarkCircle02Icon,
  Home01Icon,
  Plug01Icon,
  Settings01Icon,
} from '@hugeicons/core-free-icons'
import {
  ConnectionCheckStep,
  ModelConfigurationStep,
} from './setup-step-content'
import type { HugeiconsIcon } from '@hugeicons/react'
import type * as React from 'react'
import { INITIAL_SETUP_KEY } from './onboarding-storage'
import {
  WORKSPACE_AGENT_NAME,
  WORKSPACE_DISPLAY_NAME,
} from '@/lib/workspace-branding'

type IconType = React.ComponentProps<typeof HugeiconsIcon>['icon']

export type OnboardingStepComponentProps = {
  setCanProceed: (canProceed: boolean) => void
}

export type OnboardingStep = {
  id: string
  title: string
  description: string
  icon: IconType
  iconBg: string
  component?: React.ComponentType<OnboardingStepComponentProps>
  nextLabel?: string
  completeLabel?: string
  canProceedByDefault?: boolean
}

export const ONBOARDING_STEPS: Array<OnboardingStep> = [
  {
    id: 'welcome',
    title: `Welcome to ${WORKSPACE_DISPLAY_NAME}`,
    description:
      'Connect the runtime, confirm the model, then start a real agent task.',
    icon: Home01Icon,
    iconBg: 'bg-orange-500',
    nextLabel: 'Get Started',
  },
  {
    id: 'connection-check',
    title: 'Connection Check',
    description: 'Verify that NyxHive is running before you begin.',
    icon: Plug01Icon,
    iconBg: 'bg-emerald-500',
    component: ConnectionCheckStep,
    canProceedByDefault: false,
  },
  {
    id: 'model-configuration',
    title: 'Model Configuration',
    description: 'Review your current provider and model setup.',
    icon: Settings01Icon,
    iconBg: 'bg-cyan-500',
    component: ModelConfigurationStep,
  },
  {
    id: 'ready',
    title: 'Workspace ready',
    description:
      `Start with a task for ${WORKSPACE_AGENT_NAME}. The workspace will show context, runtime activity, approvals, and outputs as the run progresses.`,
    icon: CheckmarkCircle02Icon,
    iconBg: 'bg-emerald-500',
    completeLabel: 'Start First Task',
  },
]

export const STORAGE_KEY = INITIAL_SETUP_KEY
