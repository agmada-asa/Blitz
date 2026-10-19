/** Renders the Blitz bolt, the same mark as app/icon.svg without its black tile. */

import { useId } from "react"

/** Props for the bolt; size is its width and height in pixels. */
type BlitzLogoProps = { size?: number; className?: string }

export function BlitzLogo({ size = 28, className }: BlitzLogoProps) {
  const gradient = useId()
  return (
    <svg
      width={size}
      height={size}
      viewBox="190 170 620 660"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M789.061 499.784L498.409 813.205C475.042 838.402 435.087 820.556 435.087 784.921V471.501C435.087 449.41 451.694 431.502 472.18 431.502H762.833C795.879 431.502 812.429 474.587 789.061 499.784Z"
        fill={`url(#${gradient})`}
      />
      <path
        d="M210.939 500.216L501.591 186.795C524.958 161.598 564.913 179.444 564.913 215.079V528.499C564.913 550.59 548.306 568.498 527.82 568.498H237.167C204.121 568.498 187.571 525.413 210.939 500.216Z"
        fill={`url(#${gradient})`}
      />
      <defs>
        <linearGradient
          id={gradient}
          x1="199.778"
          y1="175"
          x2="756.921"
          y2="860.208"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#D3FBFF" />
          <stop offset="1" stopColor="#0088FF" />
        </linearGradient>
      </defs>
    </svg>
  )
}
