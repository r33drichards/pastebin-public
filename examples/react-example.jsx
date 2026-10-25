// Example React Component
// To test: Select "jsx" language and click Run

function App() {
  const [count, setCount] = React.useState(0);

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial' }}>
      <h1>Hello from React!</h1>
      <p>This is a live React component running in the browser.</p>

      <div style={{ marginTop: '20px' }}>
        <h2>Counter Example</h2>
        <p>Count: {count}</p>
        <button
          onClick={() => setCount(count + 1)}
          style={{
            padding: '10px 20px',
            fontSize: '16px',
            backgroundColor: '#3b82f6',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer'
          }}
        >
          Increment
        </button>
        <button
          onClick={() => setCount(0)}
          style={{
            padding: '10px 20px',
            fontSize: '16px',
            backgroundColor: '#ef4444',
            color: 'white',
            border: 'none',
            borderRadius: '5px',
            cursor: 'pointer',
            marginLeft: '10px'
          }}
        >
          Reset
        </button>
      </div>

      <div style={{ marginTop: '20px' }}>
        <h2>Features</h2>
        <ul>
          <li>✅ JSX syntax support</li>
          <li>✅ React Hooks (useState, useEffect, etc.)</li>
          <li>✅ Event handling</li>
          <li>✅ Live rendering in output panel</li>
          <li>✅ Full React 18 features</li>
        </ul>
      </div>
    </div>
  );
}
