import React from "react";
import ReactDOM from "react-dom/client";
import "./main.css";
import ImageProcessor from "./components/ImageProcessor";

function debounce<T>(callback: (arg: T) => void, ms = 80) {
	let timeout: ReturnType<typeof setTimeout>;

	return (arg: T) => {
		clearTimeout(timeout);
		timeout = setTimeout(() => callback(arg), ms);
	};
}

function App() {
	return (
		<div className="bg-gray-800 text-white min-h-screen flex flex-col">
			<ImageProcessor />
		</div>
	);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);
