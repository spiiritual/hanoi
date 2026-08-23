You are working on Hanoi, a cross-platform music player for Plex. It's inspired by Plexamp, the official music player for Plex on mobile. Hanoi is designed to be used on both Windows and Mac thanks to the Electrobun framework. See llms.txt for more information on Electrobun.

This project uses Pen to design the interface. The Pen project file is in the "pen" folder. You interact with Pen through its CLI in interactive headless mode. For the instructions, run "pen interactive help" in the terminal. When building the interface, always use Pen as the intended design. Never eyeball measurements or HTML/CSS code, always get it from Pen. Pen is the source of truth for the design, and it is important to follow its specifications to ensure consistency across the application.

This project seperates views by folder in the "mainview" folder. Each view has its own folder, which includes the React, HTML, CSS, and TypeScript files for that particular view.

This project uses react-doctor to find issues in the React code. To run react-doctor, use the command "npx react-doctor@latest --json --yes" from the project root. Run react-doctor everytime you change React code.

When running the app for testing purposes, use "hutch run dev" to start the app in development mode. Do not build the whole app for testing.
