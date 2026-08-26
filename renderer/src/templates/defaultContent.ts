import type { TemplateId } from '@shared/templates'
import type { Scene, SceneContent } from '@shared/project'

export interface TemplateDefaultContent {
  visualText: string
  content?: SceneContent
  icon?: Scene['icon']
  presentationMode?: Scene['presentationMode']
  background?: Scene['background']
}

/** Starter content for the cinematic multi-element templates -- so a newly
 * created scene (from the Template Library or the Timeline's Text tool)
 * looks like a composed explainer-video graphic immediately, never a plain
 * "New text" box. Undefined for every other template: those keep the
 * original generic "New text" scene exactly as before (purely additive). */
export function defaultContentForTemplate(id: TemplateId, seedId: string): TemplateDefaultContent | undefined {
  switch (id) {
    case 'tech-title-scene':
      return {
        visualText: 'Session Theft Explained',
        content: {
          eyebrow: 'TELEGRAM • SESSION THEFT • 2026',
          title: 'Your Session\nCan Be Stolen',
          value: 'Without Your Password'
        },
        icon: { iconId: 'security', color: '#5ec8ff' },
        // No explicit mode -- the template defaults to a gradient overlay on
        // its own (see TechTitleScene.tsx's SceneBackgroundLayer defaultMode).
        background: { glowColor: '#1687ff', intensity: 60 },
        presentationMode: 'full-frame'
      }
    case 'three-step-presenter-plan':
      return {
        visualText: 'Three steps to get started',
        content: {
          eyebrow: 'PLAN • ៣ ជំហាន',
          items: [
            { id: `${seedId}-0`, label: 'Install', description: 'Download and open the app', iconId: 'device', color: '#1687ff' },
            { id: `${seedId}-1`, label: 'Connect', description: 'Sign in with your account', iconId: 'check', color: '#8b42ff' },
            { id: `${seedId}-2`, label: 'Go', description: 'Start using it right away', iconId: 'arrow', color: '#18d77b' }
          ]
        },
        presentationMode: 'presenter-overlay'
      }
    case 'device-compatibility-lineup':
      return {
        visualText: 'Available on four devices',
        content: {
          title: '4 DEVICES',
          items: [
            { id: `${seedId}-0`, label: 'iPhone', iconId: 'device', color: '#34e5c2' },
            { id: `${seedId}-1`, label: 'Mac', iconId: 'chip', color: '#ff9d42' },
            { id: `${seedId}-2`, label: 'Windows', iconId: 'chip', color: '#4da3ff' },
            { id: `${seedId}-3`, label: 'Android', iconId: 'device', color: '#a8e05f' }
          ],
          cta: 'Which one is yours?'
        },
        // No explicit mode -- defaults to transparent, so the source video
        // stays visible; the color here is just a ready starting point if
        // the user later switches to Gradient Overlay / Dim Video / Solid.
        background: { glowColor: '#1687ff' },
        presentationMode: 'full-frame'
      }
    case 'social-channel-card':
      return {
        visualText: 'Sokha Dara',
        content: {
          title: 'Sokha Dara',
          value: 'Technology Creator',
          items: [
            { id: `${seedId}-0`, label: '@sokha.km', description: 'Follow', iconId: 'social', color: '#1687ff' },
            { id: `${seedId}-1`, label: 'Sokha Tech Channel', description: 'Subscribe', iconId: 'message', color: '#8b42ff' },
            { id: `${seedId}-2`, label: 'Khmer Creators Group', description: 'Join', iconId: 'social', color: '#18d77b' }
          ]
        },
        icon: { iconId: 'person', color: '#5ec8ff' },
        presentationMode: 'presenter-overlay'
      }
    case 'security-login-flow':
      return {
        visualText: 'Two-step verification blocked the login',
        content: {
          eyebrow: 'ACCOUNT SECURITY',
          items: [
            { id: `${seedId}-0`, label: 'Password', description: 'Entered correctly', iconId: 'security', color: '#18d77b', status: 'complete' },
            { id: `${seedId}-1`, label: 'SMS Code', description: 'Sent to +855 •• •• 213', iconId: 'message', color: '#f2ad18', status: 'warning' },
            { id: `${seedId}-2`, label: 'Two-Step Verification', description: 'Blocked from unknown device', iconId: 'warning', color: '#ff5364', status: 'blocked' }
          ],
          cta: 'Never share your verification code'
        }
        // No explicit mode -- the template defaults to full-frame on its
        // own (transparent background), giving the foreground device+rows
        // group a real, independently resizable contentTransform.
      }
    case 'feature-benefits-pills':
      return {
        visualText: 'Everything you need, built in',
        content: {
          eyebrow: 'WHY IT WORKS',
          title: 'Everything you need,',
          value: 'built in',
          items: [
            { id: `${seedId}-0`, label: 'Fast setup', iconId: 'check', color: '#1687ff' },
            { id: `${seedId}-1`, label: 'Secure by default', iconId: 'security', color: '#8b42ff' },
            { id: `${seedId}-2`, label: 'Works everywhere', iconId: 'device', color: '#18d77b' }
          ]
        },
        presentationMode: 'overlay'
      }
    case 'cause-effect-flow':
      return {
        visualText: 'A weak password leads to account takeover',
        content: {
          items: [
            { id: `${seedId}-0`, label: 'Weak Password', description: 'Reused across sites', value: 'CAUSE', iconId: 'warning', color: '#ff5364' },
            { id: `${seedId}-1`, label: 'Account Takeover', description: 'Session stolen', value: 'EFFECT', iconId: 'security', color: '#1687ff' }
          ]
        }
        // No explicit mode -- the template defaults to full-frame on its
        // own (transparent background), giving the foreground composition a
        // real, independently resizable contentTransform.
      }
    case 'isometric-system-diagram':
      return {
        visualText: 'How the login request travels through the system',
        content: {
          eyebrow: 'SYSTEM OVERVIEW',
          title: 'Request Path',
          items: [
            { id: `${seedId}-0`, label: 'User Device', iconId: 'device', color: '#1687ff' },
            { id: `${seedId}-1`, label: 'Security Gateway', iconId: 'security', color: '#f2ad18', status: 'warning' },
            { id: `${seedId}-2`, label: 'Server', iconId: 'chip', color: '#18d77b' }
          ]
        },
        presentationMode: 'overlay'
      }
    case 'vault-break-in-animation':
      return {
        visualText: 'How the breach reached the vault',
        content: {
          eyebrow: 'CYBERSECURITY EVENT',
          title: 'Inside the Breach'
        }
        // No explicit mode -- the template defaults to full-frame on its
        // own (transparent background).
      }
    case 'animated-break-in-vault-diagram':
      return {
        visualText: 'Tracing the break-in, floor by floor',
        content: {
          eyebrow: 'CYBERSECURITY EVENT',
          title: 'Tracing the Break-In'
        }
        // No explicit mode -- the template defaults to full-frame on its
        // own (transparent background).
      }
    case 'data-center-cyber-intrusion':
      return {
        visualText: 'An attacker probes the firewall',
        content: {
          eyebrow: 'CYBERSECURITY EVENT',
          title: 'Data Center Intrusion'
        }
        // No explicit mode -- the template defaults to full-frame on its
        // own (transparent background).
      }
    case 'hospital-emergency-response':
      return {
        visualText: 'From arrival to recovery',
        content: {
          eyebrow: 'EMERGENCY RESPONSE',
          title: 'From Arrival to Recovery'
        }
        // No explicit mode -- the template defaults to full-frame on its
        // own (transparent background).
      }
    default:
      return undefined
  }
}
